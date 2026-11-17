import * as THREE from 'three';
import { Batch } from './batch';
import { canvasTex, noiseFill } from './textures';
import { clamp, wrapI } from './util';
import type { Track } from './track';
import type { TrackDef } from './tracks';

// ============================================================================
// Scenery: sky, terrain, trees, grandstands, skyline, gantry
// ============================================================================
export function buildScenery(tr: Track, scene: THREE.Scene, def: TrackDef) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < tr.N; i++) { minX = Math.min(minX, tr.X[i]); maxX = Math.max(maxX, tr.X[i]); minZ = Math.min(minZ, tr.Z[i]); maxZ = Math.max(maxZ, tr.Z[i]); }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;

  // Terrain
  const grassTex = canvasTex(256, 256, (g, w, h) => {
    noiseFill(g, w, h, [92, 128, 58], 34);
    g.globalAlpha = 0.08; g.fillStyle = '#000';
    for (let x = 0; x < w; x += 64) g.fillRect(x, 0, 32, h);      // mowing stripes
  });
  grassTex.repeat.set(700, 700);
  const tg = new THREE.PlaneGeometry(7000, 7000, 140, 140);
  tg.rotateX(-Math.PI / 2);
  const cols = new Float32Array(tg.attributes.position.count * 3), p = tg.attributes.position;
  const c1 = new THREE.Color(0x8fb35a), c2 = new THREE.Color(0x6f9a45), c3 = new THREE.Color(0xb3ad6a), tmp = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + cx, z = p.getZ(i) + cz;
    const n1 = Math.sin(x * 0.004) * Math.cos(z * 0.0047) + 0.5 * Math.sin(x * 0.011 + z * 0.009);
    const n2 = Math.sin(x * 0.0021 - z * 0.0017 + 1.3);
    tmp.copy(c1).lerp(c2, clamp(0.5 + 0.5 * n1, 0, 1)).lerp(c3, clamp(n2 * 0.5, 0, 0.6));
    cols[i * 3] = tmp.r; cols[i * 3 + 1] = tmp.g; cols[i * 3 + 2] = tmp.b;
  }
  tg.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  const terrainMat = new THREE.MeshStandardMaterial({ map: grassTex, vertexColors: true, roughness: 1 });
  const terrain = new THREE.Mesh(tg, terrainMat);
  terrain.position.set(cx, -0.03, cz);
  terrain.receiveShadow = true;
  scene.add(terrain);

  // Trees (instanced)
  const rng = mulberry32(1337);
  const treePos = [];
  for (let tries = 0; tries < 7000 && treePos.length < def.trees; tries++) {
    const x = minX - 500 + rng() * (maxX - minX + 1000), z = minZ - 500 + rng() * (maxZ - minZ + 1000);
    const d = tr.nearestDist(x, z);
    if (d < 48) continue;
    if (d > 260 && rng() < 0.6) continue;            // denser near the circuit
    treePos.push([x, z, 0.7 + rng() * 0.8, rng() * Math.PI * 2]);
  }
  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.35, 3.2, 6).translate(0, 1.6, 0);
  const leafGeo = new THREE.IcosahedronGeometry(2.6, 0).scale(1, 1.25, 1).translate(0, 5.2, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x6b5440, roughness: 1 }), treePos.length);
  const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true }), treePos.length);
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
  const leafCols = [0x4f7a34, 0x5d8a3a, 0x3f6a2e, 0x6e8f45, 0x56743a];
  treePos.forEach(([x, z, s, r], k) => {
    q.setFromAxisAngle(Y, r); sc.set(s, s * (0.9 + rng() * 0.4), s); pos.set(x, 0, z);
    mtx.compose(pos, q, sc); trunks.setMatrixAt(k, mtx); leaves.setMatrixAt(k, mtx);
    leaves.setColorAt(k, tmp.set(leafCols[k % leafCols.length]).multiplyScalar(0.85 + rng() * 0.3));
  });
  trunks.castShadow = leaves.castShadow = true;
  scene.add(trunks, leaves);

  // Distant city skyline (north, i.e. -z), at circuits that have one
  const bGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const bCount = def.skyline ? 160 : 0;
  const blds = new THREE.InstancedMesh(bGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.2 }), bCount);
  for (let k = 0; k < bCount; k++) {
    const x = cx - 900 + rng() * 1900, z = minZ - 1900 - rng() * 1300;
    const h = 30 + Math.pow(rng(), 2.2) * 230, w = 25 + rng() * 45;
    mtx.compose(pos.set(x, 0, z), q.identity(), sc.set(w, h, 25 + rng() * 45));
    blds.setMatrixAt(k, mtx);
    blds.setColorAt(k, tmp.set([0x9aa6b2, 0xb7c0c8, 0x7f8c99, 0xc9ced3][k % 4]));
  }
  scene.add(blds);

  // Pit building on def.pitSide of the main straight, grandstands along the other side
  const standMats = {
    concrete: new THREE.MeshStandardMaterial({ color: 0xb9b6ae, roughness: 0.9 }),
    // One row of seated spectators per tier front (24 m x 1.2 m, so the texels are roughly square)
    crowd: new THREE.MeshStandardMaterial({ map: canvasTex(1024, 64, (g, w, h) => {
      g.fillStyle = '#39414d'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#2c333d'; g.fillRect(0, 40, w, h - 40);
      const shirts = ['#d8d4cc', '#2f5fa8', '#c23b30', '#e0b03a', '#3d7a48', '#1e2228', '#e8e8e8', '#7c4f8f', '#f07a2a', '#5d6873'];
      const skins = ['#f1c6a4', '#d9a27c', '#b77b55', '#8a5a3c', '#f5d2b8'];
      for (let x = 4; x < w - 18; x += 20 + Math.random() * 4) {
        if (Math.random() < 0.12) continue;                                     // empty seat
        const dx = x + Math.random() * 3, dy = Math.random() * 4 - (Math.random() < 0.1 ? 8 : 0);   // a few stand up
        g.fillStyle = shirts[Math.floor(Math.random() * shirts.length)];
        g.fillRect(dx, 26 + dy, 15, 40);                                        // torso
        g.fillStyle = skins[Math.floor(Math.random() * skins.length)];
        g.beginPath(); g.arc(dx + 7.5, 19 + dy, 6, 0, Math.PI * 2); g.fill();   // head
        if (Math.random() < 0.4) { g.fillStyle = Math.random() < 0.5 ? '#2a2420' : '#c9b48a'; g.fillRect(dx + 1, 11 + dy, 13, 5); }   // hair / cap
      }
    }), roughness: 1 }),
    roof: new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.6, metalness: 0.3 }),
  };
  // Every stand, the pit building and the gantry are merged into one mesh per material (a few draw calls in all).
  const batch = new Batch(), M = new THREE.Matrix4(), L = new THREE.Matrix4(), e = new THREE.Euler();
  const part = (geo: THREE.BufferGeometry, x: number, y: number, z: number, mat: THREE.Material | THREE.Material[]) =>
    batch.add(geo, L.multiplyMatrices(M, L.makeTranslation(x, y, z)), mat);
  const tierGeo = new THREE.BoxGeometry(24, 1.2, 2.2), backGeo = new THREE.BoxGeometry(24, 9, 0.5);
  const roofGeo = new THREE.BoxGeometry(25, 0.3, 13), postGeo = new THREE.BoxGeometry(0.4, 9, 0.4);
  const tierMats = [standMats.concrete, standMats.concrete, standMats.concrete, standMats.concrete, standMats.crowd, standMats.concrete];
  for (const { x, z, yaw } of standBays(tr, def)) {
    // local +z points to the track centre
    M.compose(pos.set(x, 0, z), q.setFromEuler(e.set(0, yaw, 0)), sc.set(1, 1, 1));
    for (let t = 0; t < 5; t++) part(tierGeo, 0, 0.6 + t * 1.2, -t * 2.2, tierMats);
    part(backGeo, 0, 4.5, -10.2, standMats.concrete);
    part(roofGeo, 0, 9.2, -4.5, standMats.roof);
    for (const x of [-11.5, 11.5]) part(postGeo, x, 4.5, 1.5, standMats.concrete);
  }
  // Pit building
  const pit = pitBuilding(tr, def);
  if (pit) {
    M.compose(pos.set(pit.x, 4, pit.z), q.setFromEuler(e.set(0, pit.yaw, 0)), sc.set(1, 1, 1));
    // garages along the track-facing face (its u runs along the building)
    const pitFront = new THREE.MeshStandardMaterial({ map: pitTexture(), roughness: 0.8 });
    pitFront.map!.repeat.set(Math.max(1, Math.round(pit.len / 32)), 1);
    part(new THREE.BoxGeometry(12, 8, pit.len), 0, 0, 0, [standMats.concrete, pitFront, standMats.roof, standMats.concrete, standMats.concrete, standMats.concrete]);
  }
  // Start gantry: local x maps to the left normal, rotation.y = atan2(-NZ, NX) maps (1,0,0) -> (NX, 0, NZ)
  {
    const m = new THREE.MeshStandardMaterial({ color: 0x2a2e35, roughness: 0.5, metalness: 0.6 });
    const lamp = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0x330000 });
    const { wl, wr } = gantryPosts(tr, def);
    M.compose(pos.set(tr.X[0], 0, tr.Z[0]), q.setFromEuler(e.set(0, Math.atan2(-tr.NZ[0], tr.NX[0]), 0)), sc.set(1, 1, 1));
    const gpost = new THREE.BoxGeometry(GANTRY_POST, 7, GANTRY_POST);
    for (const o of [wl, -wr]) part(gpost, o, 3.5, 0, m);
    part(new THREE.BoxGeometry(wl + wr, 0.9, 0.6), (wl - wr) / 2, 6.8, 0, m);
    const lampGeo = new THREE.BoxGeometry(0.5, 0.5, 0.2);
    for (let k = 0; k < 5; k++) part(lampGeo, -1.4 + k * 0.7, 6.8, 0.35, lamp);
  }
  batch.build(scene);
  return { bounds: { cx, cz, minX, maxX, minZ, maxZ }, terrain: terrainMat };
}

// The start gantry's posts: their centres' distance left (wl) and right (wr) of the centreline at the line. 2 m off the
// track's edge, except on the pit building's side, where the post stands beyond a race weekend's pit lane (whose
// outer edge stays 0.6 m off the barrier, or 6 m beyond the track's edge where there is none: raceGeometry.ts), not
// on the lane's inner line.
export const GANTRY_POST = 0.5;   // m square
export function gantryPosts(tr: Track, def: Pick<TrackDef, 'pitSide'>): { wl: number; wr: number } {
  const beyond = (bar: number, valid: boolean, edge: number) => Math.max(edge + 2, valid ? bar - 0.3 : edge + 6.5);
  return def.pitSide > 0 ? { wl: beyond(tr.barL[0], !!tr.barLValid[0], tr.WL[0]), wr: tr.WR[0] + 2 }
    : { wl: tr.WL[0] + 2, wr: beyond(tr.barR[0], !!tr.barRValid[0], tr.WR[0]) };
}

// Where the buildings go. A building may not reach another part of the circuit (a street circuit's straight often
// has a hairpin or another straight just beyond its walls): no point of its footprint may lie inside any stretch's
// walls (at the side of a centreline sample, closer than its barrier offset + 0.5 m). The straight it stands beside
// (samples a to b, and 100 m either side) is left out of that: the building is placed off its walls. A stand bay
// that would intrude is left out, the pit building shortened from its ends until it fits.
const clear = (tr: Track, pts: [number, number][], a: number, b: number) => pts.every(([x, z]) => {
  const ds = tr.L / tr.N, m = Math.round(100 / ds);
  for (let j = 0; j < tr.N; j++) {
    if (wrapI(j - (a - m), tr.N) <= b - a + 2 * m) continue;
    const dx = x - tr.X[j], dz = z - tr.Z[j];
    if (dx * dx + dz * dz > 3600 || Math.abs(dx * tr.TX[j] + dz * tr.TZ[j]) > 1.5) continue;
    const lat = dx * tr.NX[j] + dz * tr.NZ[j];
    if (Math.abs(lat) < (lat > 0 ? tr.barL[j] : tr.barR[j]) + 0.5) return false;
  }
  return true;
});
type Footprint = { x: number; z: number; yaw: number };
// The points of a box (local width w across, depth d with +z towards the track from `front`, length along) to test.
function boxPoints(cx: number, cz: number, ax: number, az: number, halfLen: number, nx: number, nz: number, d0: number, d1: number) {
  const pts: [number, number][] = [];
  for (let u = -halfLen; u <= halfLen + 1e-6; u += Math.max(1, halfLen / 8)) {
    for (const d of [d0, (d0 + d1) / 2, d1]) pts.push([cx + ax * u + nx * d, cz + az * u + nz * d]);
  }
  return pts;
}

// Grandstand bays (24 m wide, ~12 m deep) along the straight, opposite the pits.
export function standBays(tr: Track, def: TrackDef): Footprint[] {
  const bays: Footprint[] = [], stepI = Math.round(26 / (tr.L / tr.N));
  for (let k = -def.stands[0]; k <= def.stands[1]; k++) {
    const i = wrapI(k * stepI, tr.N);
    const side = -def.pitSide, bar = side > 0 ? tr.barL : tr.barR, valid = side > 0 ? tr.barLValid : tr.barRValid;
    if (!valid[i] || Math.abs(tr.KS[i]) > 1 / 600) continue;
    const off = side * (bar[i] + 4), x = tr.X[i] + tr.NX[i] * off, z = tr.Z[i] + tr.NZ[i] * off;
    // outward normal side*N, the bay runs along the tangent; it reaches 1.5 m towards the track and 10.5 m back
    if (!clear(tr, boxPoints(x, z, tr.TX[i], tr.TZ[i], 12.5, side * tr.NX[i], side * tr.NZ[i], -1.5, 10.5), i, i)) continue;
    bays.push({ x, z, yaw: Math.atan2(-side * tr.NX[i], -side * tr.NZ[i]) });
  }
  return bays;
}

// The pit building (12 m deep, 8 m high) along the chord of the straight from def.pit[0] to def.pit[1]. k0, k1: the
// samples (counted from the line, negative before it) its ends stand beside, once shortened to fit.
export function pitBuilding(tr: Track, def: Pick<TrackDef, 'pit' | 'pitSide'>): (Footprint & { len: number; k0: number; k1: number }) | null {
  const ds = tr.L / tr.N;
  let k0 = Math.round(def.pit[0] / ds), k1 = Math.round(def.pit[1] / ds);
  while (k1 - k0 >= 20) {   // at least 40 m long
    const i0 = wrapI(k0, tr.N), i1 = wrapI(k1, tr.N);
    const ax = tr.X[i1] - tr.X[i0], az = tr.Z[i1] - tr.Z[i0], len = Math.hypot(ax, az);
    const im = wrapI(Math.round((k0 + k1) / 2), tr.N), side = def.pitSide, off = side * ((side > 0 ? tr.barL : tr.barR)[im] + 9);
    const x = tr.X[im] + tr.NX[im] * off, z = tr.Z[im] + tr.NZ[im] * off;
    // the chord's outward normal, towards the building's side
    const nx = (side * az) / len, nz = (-side * ax) / len;
    if (clear(tr, boxPoints(x, z, ax / len, az / len, len / 2, nx, nz, -6, 6), i0, i0 + k1 - k0)) {
      // On the left the building's local -x faces the track; on the right it is turned round so that face still does.
      return { x, z, len, k0, k1, yaw: Math.atan2(ax, az) + (side > 0 ? 0 : Math.PI) };
    }
    k0 += 2; k1 -= 2;
  }
  return null;
}

// Pit building frontage, 32 m x 8 m per repeat: four garages under a glazed upper floor and a dark roof band.
function pitTexture() {
  return canvasTex(512, 128, (g, w, h) => {
    noiseFill(g, w, h, [196, 194, 188], 10);
    g.fillStyle = '#1f2630'; g.fillRect(0, 0, w, 12);                                  // roof band
    g.fillStyle = '#5d7f9e'; g.fillRect(0, 22, w, 26);                                 // upper-floor glazing
    g.fillStyle = 'rgba(255,255,255,0.22)'; for (let x = 0; x < w; x += 32) g.fillRect(x + 4, 24, 9, 22);
    g.fillStyle = '#9aa1a8'; for (let x = 0; x < w; x += 32) g.fillRect(x, 22, 3, 26);   // mullions
    for (let k = 0; k < 4; k++) {
      const x0 = k * 128 + 12;
      g.fillStyle = ['#d8262b', '#1d4f9e', '#f0b323', '#2b8a4a'][k]; g.fillRect(x0, 54, 104, 6);   // team colour strip
      g.fillStyle = '#1b1f24'; g.fillRect(x0, 62, 104, 66);                            // garage opening
      g.fillStyle = '#3a4048'; g.fillRect(x0 + 4, 62, 96, 30);                         // half-open shutter
      g.fillStyle = '#4a515a'; for (let y = 64; y < 92; y += 4) g.fillRect(x0 + 4, y, 96, 1);
    }
  });
}

function mulberry32(a: number): () => number {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// The sky dome. With the WEATHER define (weather.ts sets it only while it is overcast, so a dry day's shader is the
// plain one) the uniforms uOvercast (0..1), uRain (0..1) and uFog (the fog colour, display space) turn it grey: the
// horizon is the fog's colour, the cloud closes over and the sun goes behind it.
export function buildSky(scene: THREE.Scene, sunDir: THREE.Vector3) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false,
    uniforms: { sunDir: { value: sunDir }, uOvercast: { value: 0 }, uRain: { value: 0 }, uFog: { value: new THREE.Color(0.80, 0.87, 0.93) } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.); gl_Position = p.xyww; }`,
    // Colours are display-space and match the fog colour at the horizon. Clouds: value-noise fbm on a flat layer
    // (direction projected onto a plane overhead), thinned out towards the horizon so it stays hazy there.
    fragmentShader: `varying vec3 vDir; uniform vec3 sunDir;
      #ifdef WEATHER
      uniform float uOvercast, uRain; uniform vec3 uFog;
      #endif
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
      float fbm(vec2 p){ float v = 0., a = 0.5; for (int k = 0; k < 5; k++) { v += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return v; }
      void main(){ vec3 d = normalize(vDir); float h = clamp(d.y, 0., 1.);
        #ifdef WEATHER
        vec3 horizon = uFog, zenith = mix(vec3(0.28, 0.52, 0.86), uFog, 0.5 * uOvercast);
        #else
        vec3 horizon = vec3(0.80, 0.87, 0.93), zenith = vec3(0.28, 0.52, 0.86);
        #endif
        vec3 col = mix(horizon, zenith, pow(h, 0.55));
        float s = max(dot(d, normalize(sunDir)), 0.);
        if (d.y > 0.) {
          vec2 uv = d.xz / (d.y + 0.12) * 1.6;
          float c = smoothstep(0.50, 0.78, fbm(uv + vec2(3.7, 1.2)));
          c *= smoothstep(0.02, 0.22, d.y);
          float shade = 0.82 + 0.18 * fbm(uv * 1.7 + 5.);            // lumpy undersides
          vec3 cloud = mix(vec3(0.74, 0.79, 0.86), vec3(1.0, 0.99, 0.97), shade) + vec3(1.0, 0.9, 0.7) * pow(s, 8.) * 0.25;
          col = mix(col, cloud, c * 0.85);
          #ifdef WEATHER
          // Overcast: one grey deck, darker and lumpier the heavier the rain. Low down it is exactly the fog's colour:
          // anything far off (a city skyline) is fogged to that colour too, and must not stand out against the sky.
          float n = fbm(uv * 0.55 + vec2(1.3, 7.1) + 0.6 * vec2(fbm(uv * 0.3), 0.));
          vec3 deck = uFog * (1.03 - 0.08 * h) * mix(1.0, 0.72 + 0.5 * n, 0.5 + 0.5 * uRain);
          col = mix(col, mix(deck, uFog, 1. - smoothstep(0.14, 0.5, d.y)), uOvercast);
          #endif
        }
        #ifdef WEATHER
        col += vec3(1.0, 0.92, 0.75) * (pow(s, 900.) * 6. + pow(s, 12.) * 0.18) * (1. - uOvercast) * (1. - uOvercast);
        #else
        col += vec3(1.0, 0.92, 0.75) * (pow(s, 900.) * 6. + pow(s, 12.) * 0.18);
        #endif
        if (d.y < 0.) col = horizon * mix(1.0, 0.85, clamp(-d.y * 4., 0., 1.));
        gl_FragColor = vec4(col, 1.); }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 32, 16), mat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);
  return sky;
}
