import * as THREE from 'three';
import { Batch } from './batch';
import { canvasTex, noiseFill } from './textures';
import { floodlit, type Glow } from './timeOfDay';
import { WOODS, woodsOf, type SceneKind } from './trackside';
import { clamp, wrapI } from './util';
import { LANE, laneAt, pitFootprint, type LanePos } from './pitLane';
import type { Track } from './track';
import type { TrackDef } from './tracks';

// ============================================================================
// Scenery: sky, terrain, grandstands, pit building, gantry, and the clearance test everything placed round the
// circuit goes through (trees, buildings, hills and the rest: trackside.ts)
// ============================================================================
// The ground's colours by the kind of place (three, blended by large-scale noise) and whether it is sand.
const GROUND: Record<SceneKind, { c: [number, number, number]; sand?: boolean }> = {
  forest: { c: [0x86ad58, 0x5f8a3e, 0x9aa35c] },
  park: { c: [0x8fb35a, 0x6f9a45, 0xb3ad6a] },
  country: { c: [0x96b25e, 0x77984a, 0xbcb070] },
  dry: { c: [0xb9b276, 0x97a05a, 0xd0b884] },
  city: { c: [0x9aa07c, 0x80886a, 0xaaa690] },
  desert: { c: [0xe6cc98, 0xd4b27c, 0xeedcb0], sand: true },
  dunes: { c: [0xddcc9c, 0xa8ae70, 0xe6d6aa], sand: true },
};

export function buildScenery(tr: Track, scene: THREE.Scene, def: TrackDef, glow: Glow) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < tr.N; i++) { minX = Math.min(minX, tr.X[i]); maxX = Math.max(maxX, tr.X[i]); minZ = Math.min(minZ, tr.Z[i]); maxZ = Math.max(maxZ, tr.Z[i]); }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;

  // Terrain
  const ground = GROUND[def.scene];
  const grassTex = canvasTex(256, 256, (g, w, h) => {
    if (ground.sand) {
      noiseFill(g, w, h, [226, 214, 190], 26, 0.03);
      g.globalAlpha = 0.07; g.fillStyle = '#5a4a30';
      for (let y = 0; y < h; y += 16) g.fillRect(0, y + ((y * 7) % 5), w, 3);   // wind ripples
      return;
    }
    noiseFill(g, w, h, [92, 128, 58], 34);
    g.globalAlpha = 0.08; g.fillStyle = '#000';
    for (let x = 0; x < w; x += 64) g.fillRect(x, 0, 32, h);      // mowing stripes
  });
  grassTex.repeat.set(700, 700);
  const tg = new THREE.PlaneGeometry(7000, 7000, 140, 140);
  tg.rotateX(-Math.PI / 2);
  const cols = new Float32Array(tg.attributes.position.count * 3), p = tg.attributes.position;
  const [c1, c2, c3] = ground.c.map((c) => new THREE.Color(c)), tmp = new THREE.Color();
  // under the woods of a forest or park the ground is darker (woodland floor seen from afar)
  const woods = def.scene === 'forest' || def.scene === 'park' ? woodsOf(def) : null, under = new THREE.Color(ground.c[1]).multiplyScalar(0.62);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + cx, z = p.getZ(i) + cz;
    const n1 = Math.sin(x * 0.004) * Math.cos(z * 0.0047) + 0.5 * Math.sin(x * 0.011 + z * 0.009);
    const n2 = Math.sin(x * 0.0021 - z * 0.0017 + 1.3), n3 = Math.sin(x * 0.019 + 0.7) * Math.sin(z * 0.023 - 1.1);
    tmp.copy(c1).lerp(c2, clamp(0.5 + 0.5 * n1, 0, 1)).lerp(c3, clamp(n2 * 0.5, 0, 0.6)).multiplyScalar(0.94 + 0.08 * n3);
    if (woods) tmp.lerp(under, clamp((woods(x, z) - WOODS + 0.04) / 0.12, 0, 1) * (def.scene === 'forest' ? 0.85 : 0.5) * clamp((nearestSample(tr, x, z).d - 30) / 50, 0, 1));
    cols[i * 3] = tmp.r; cols[i * 3 + 1] = tmp.g; cols[i * 3 + 2] = tmp.b;
  }
  tg.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  const terrainMat = floodlit(new THREE.MeshStandardMaterial({ map: grassTex, vertexColors: true, roughness: 1 }));
  const terrain = new THREE.Mesh(tg, terrainMat);
  terrain.position.set(cx, -0.03, cz);
  terrain.receiveShadow = true;
  scene.add(terrain);

  const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();

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
    // the strip of lamps under each roof's front edge (lit at dusk and night)
    lights: glow.add(new THREE.MeshStandardMaterial({ color: 0x55585c, emissive: 0xfff2dc, emissiveIntensity: 0, roughness: 0.5 }), 2.4),
  };
  // Every stand, the pit building and the gantry are merged into one mesh per material (a few draw calls in all).
  const batch = new Batch(), M = new THREE.Matrix4(), L = new THREE.Matrix4(), e = new THREE.Euler();
  const part = (geo: THREE.BufferGeometry, x: number, y: number, z: number, mat: THREE.Material | THREE.Material[]) =>
    batch.add(geo, L.multiplyMatrices(M, L.makeTranslation(x, y, z)), mat);
  const tierGeo = new THREE.BoxGeometry(24, 1.2, 2.2), backGeo = new THREE.BoxGeometry(24, 9, 0.5);
  const roofGeo = new THREE.BoxGeometry(25, 0.3, 13), postGeo = new THREE.BoxGeometry(0.4, 9, 0.4), stripGeo = new THREE.BoxGeometry(23, 0.12, 0.5);
  const tierMats = [standMats.concrete, standMats.concrete, standMats.concrete, standMats.concrete, standMats.crowd, standMats.concrete];
  for (const { x, z, yaw } of standBays(tr, def)) {
    // local +z points to the track centre
    M.compose(pos.set(x, 0, z), q.setFromEuler(e.set(0, yaw, 0)), sc.set(1, 1, 1));
    for (let t = 0; t < 5; t++) part(tierGeo, 0, 0.6 + t * 1.2, -t * 2.2, tierMats);
    part(backGeo, 0, 4.5, -10.2, standMats.concrete);
    part(roofGeo, 0, 9.2, -4.5, standMats.roof);
    for (const x of [-11.5, 11.5]) part(postGeo, x, 4.5, 1.5, standMats.concrete);
    part(stripGeo, 0, 8.98, 1.3, standMats.lights);
  }
  // Pit building
  const pit = pitBuilding(tr);
  if (pit) {
    M.compose(pos.set(pit.x, 4, pit.z), q.setFromEuler(e.set(0, pit.yaw, 0)), sc.set(1, 1, 1));
    // garages along the track-facing face (its u runs along the building)
    const front = pitTexture(), pitFront = glow.add(new THREE.MeshStandardMaterial({ map: front.map, emissive: 0xffffff, emissiveMap: front.lit, emissiveIntensity: 0, roughness: 0.8 }), 1.2);
    for (const t of [front.map, front.lit]) t.repeat.set(Math.max(1, Math.round(pit.len / 32)), 1);
    part(new THREE.BoxGeometry(12, 8, pit.len), 0, 0, 0, [standMats.concrete, pitFront, standMats.roof, standMats.concrete, standMats.concrete, standMats.concrete]);
  }
  // Start gantry: local x maps to the left normal, rotation.y = atan2(-NZ, NX) maps (1,0,0) -> (NX, 0, NZ)
  {
    const m = new THREE.MeshStandardMaterial({ color: 0x2a2e35, roughness: 0.5, metalness: 0.6 });
    const lamp = glow.add(new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0x330000 }), 3, 1);
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
// track's edge, except on the pit lane's side: on top of the pit wall where the lane runs beside the line (the
// track's barrier there is the pit wall's track face: pitLane.ts), else 2 m off the edge if that is clear of the lane
// and its walls, else just beyond the lane's far wall.
export const GANTRY_POST = 0.5;   // m square
export function gantryPosts(tr: Track, def: Pick<TrackDef, 'pitSide'>): { wl: number; wr: number } {
  const side = def.pitSide, edge = side > 0 ? tr.WL[0] : tr.WR[0], bar = side > 0 ? tr.barL[0] : tr.barR[0], valid = side > 0 ? tr.barLValid[0] : tr.barRValid[0];
  const at = (o: number) => [tr.X[0] + tr.NX[0] * side * o, tr.Z[0] + tr.NZ[0] * side * o] as const;
  const lane = tr.pit, free = (o: number) => !lane || !pitFootprint(lane, ...at(o), GANTRY_POST / 2 + 0.1);
  let post = edge + 2;
  const p: LanePos = { d: 0, off: 0, k: 0 }, onLane = (o: number) => !!lane && laneAt(lane, ...at(o), p);
  if (lane && valid && !onLane(bar + LANE.wall / 2) && onLane(bar + LANE.wall + 1)) post = bar + LANE.wall / 2;   // (on the pit wall)
  else while (!free(post) && post < edge + 200) post += 0.5;
  return side > 0 ? { wl: post, wr: tr.WR[0] + 2 } : { wl: tr.WL[0] + 2, wr: post };
}

// ---------------------------------------------------------------------------- the clearance test
// Everything placed round the circuit (stands, the pit building, trees, buildings, masts, bridges: trackside.ts)
// goes through clearOf. A thing may not reach any part of the circuit: no point of its footprint may lie inside any
// stretch's walls (at the side of a centreline sample, closer than its barrier offset + `margin`). `skip`: samples
// (counted from the line, may be negative) of the stretch it stands beside, whose walls it may reach (and 100 m
// either side), as a building placed off its own straight's walls, or a bridge's deck over its straight. Nothing
// may stand on the circuit's pit lane, its walls, its openings or its building, nor within `margin` of them
// (pitFootprint, pitLane.ts: the real lane wherever it runs, a cut across the infield included). `reserve`: keep
// PIT_RESERVE m more round the lane (trees, buildings, masts and bridge legs: room to see and walk round it).
// `buildings`: also keep `margin` clear of the grandstands and the pit building. A stand bay that would intrude is
// left out.
export const PIT_RESERVE = 6;   // m round the pit lane's footprint kept clear by `reserve`
export interface Keep { margin?: number; skip?: readonly [from: number, to: number]; reserve?: boolean; buildings?: boolean }
type ClearDef = Pick<TrackDef, 'pitSide'> & Partial<Pick<TrackDef, 'pit' | 'stands'>>;
export function clearOf(tr: Track, def: ClearDef, pts: readonly (readonly [number, number])[], keep: Keep = {}): boolean {
  const ds = tr.L / tr.N, m = Math.round(100 / ds), margin = keep.margin ?? 0.5, grid = gridOf(tr);
  const reach = 60 + margin, lane = tr.pit, laneMargin = margin + (keep.reserve ? PIT_RESERVE : 0);
  // how far along the track a sample's test reaches: its spacing (so a wall whose offset jumps between two samples is
  // still seen), or 1.5 m for things placed off their own stretch (the stands and pit building, as first placed)
  const tol = keep.skip ? 1.5 : ds, built = keep.buildings ? buildingsOf(tr, def) : null;
  for (const [x, z] of pts) {
    if (built) for (const c of built) if ((x - c.x) ** 2 + (z - c.z) ** 2 < (c.r + margin) ** 2) return false;
    if (lane && pitFootprint(lane, x, z, laneMargin)) return false;
    for (const j of grid.near(x, z, reach)) {
      if (keep.skip && wrapI(j - (keep.skip[0] - m), tr.N) <= keep.skip[1] - keep.skip[0] + 2 * m) continue;
      const dx = x - tr.X[j], dz = z - tr.Z[j], d2 = dx * dx + dz * dz, along = Math.abs(dx * tr.TX[j] + dz * tr.TZ[j]);
      const lat = dx * tr.NX[j] + dz * tr.NZ[j], bar = lat > 0 ? tr.barL[j] : tr.barR[j];
      if (d2 <= 3600 && along <= tol && Math.abs(lat) < bar + margin) return false;
    }
  }
  return true;
}
// The grandstands and pit building as circles (x, z, radius) covering their footprints (made once per track).
const builtCache = new WeakMap<Track, { x: number; z: number; r: number }[]>();
function buildingsOf(tr: Track, def: ClearDef) {
  let out = builtCache.get(tr);
  if (out) return out;
  out = [];
  if (def.stands && def.pit) {
    // a bay reaches 1.5 m towards the track and 10.5 m back from (x, z); yaw turns local +z towards the track
    for (const b of standBays(tr, def as TrackDef)) {
      const tx = Math.sin(b.yaw), tz = Math.cos(b.yaw), cx = b.x - tx * 4.5, cz = b.z - tz * 4.5;
      for (const u of [-8, 0, 8]) out.push({ x: cx + tz * u, z: cz - tx * u, r: 8.5 });
    }
    const pit = pitBuilding(tr);
    if (pit) {
      const ax = Math.sin(pit.yaw), az = Math.cos(pit.yaw), n = Math.ceil(pit.len / 8);
      for (let k = 0; k <= n; k++) { const u = -pit.len / 2 + (pit.len * k) / n; out.push({ x: pit.x + ax * u, z: pit.z + az * u, r: 8.5 }); }
    }
  }
  builtCache.set(tr, out);
  return out;
}

// The track's samples in 50 m cells, for clearOf and nearestSample (made once per track).
const grids = new WeakMap<Track, { near(x: number, z: number, r: number): number[] }>();
function gridOf(tr: Track) {
  let g = grids.get(tr);
  if (g) return g;
  const C = 50, cells = new Map<number, number[]>(), key = (a: number, b: number) => a * 100003 + b;
  for (let j = 0; j < tr.N; j++) {
    const k = key(Math.floor(tr.X[j] / C), Math.floor(tr.Z[j] / C));
    (cells.get(k) ?? (cells.set(k, []), cells.get(k)!)).push(j);
  }
  const out: number[] = [];
  g = {
    near(x, z, r) {
      out.length = 0;
      const a0 = Math.floor((x - r) / C), a1 = Math.floor((x + r) / C), b0 = Math.floor((z - r) / C), b1 = Math.floor((z + r) / C);
      for (let a = a0; a <= a1; a++) for (let b = b0; b <= b1; b++) { const l = cells.get(key(a, b)); if (l) for (const j of l) out.push(j); }
      return out;
    },
  };
  grids.set(tr, g);
  return g;
}
// The nearest centreline sample to a point: its index, the distance and the point's offset to the left of it.
export function nearestSample(tr: Track, x: number, z: number): { i: number; d: number; lat: number } {
  let best = -1, bd = Infinity;
  for (const r of [60, 250]) {
    for (const j of gridOf(tr).near(x, z, r)) { const d = (x - tr.X[j]) ** 2 + (z - tr.Z[j]) ** 2; if (d < bd) { bd = d; best = j; } }
    if (best >= 0 && bd <= r * r) break;
  }
  if (best < 0 || bd > 250 * 250) for (let j = 0; j < tr.N; j += 2) { const d = (x - tr.X[j]) ** 2 + (z - tr.Z[j]) ** 2; if (d < bd) { bd = d; best = j; } }
  return { i: best, d: Math.sqrt(bd), lat: (x - tr.X[best]) * tr.NX[best] + (z - tr.Z[best]) * tr.NZ[best] };
}
type Footprint = { x: number; z: number; yaw: number };
// The points of a box (local width w across, depth d with +z towards the track from `front`, length along) to test.
export function boxPoints(cx: number, cz: number, ax: number, az: number, halfLen: number, nx: number, nz: number, d0: number, d1: number) {
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
    if (!clearOf(tr, def, boxPoints(x, z, tr.TX[i], tr.TZ[i], 12.5, side * tr.NX[i], side * tr.NZ[i], -1.5, 10.5), { skip: [i, i] })) continue;
    bays.push({ x, z, yaw: Math.atan2(-side * tr.NX[i], -side * tr.NZ[i]) });
  }
  return bays;
}

// The pit building (12 m deep, 8 m high) beside the pit lane's working stretch, beyond its far wall (pitLane.ts
// places it, shortened or left out where it would reach the circuit). Its local -x (the garages) faces the lane.
export function pitBuilding(tr: Track): (Footprint & { len: number }) | null {
  const b = tr.pit?.building;
  return b ? { x: b.x, z: b.z, len: 2 * b.halfLen, yaw: Math.atan2(b.nz, -b.nx) } : null;
}

// Pit building frontage, 32 m x 8 m per repeat: four garages under a glazed upper floor and a dark roof band; `lit`
// is the emissive map of its windows and garages, lit at dusk and night.
function pitTexture() {
  const lit = canvasTex(512, 128, (g, w) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, w, 128);
    g.fillStyle = '#c8d8e8'; g.fillRect(0, 22, w, 26);
    g.fillStyle = '#000'; for (let x = 0; x < w; x += 32) g.fillRect(x, 22, 3, 26);
    for (let k = 0; k < 4; k++) { g.fillStyle = '#fff4e0'; g.fillRect(k * 128 + 12, 92, 104, 36); g.fillStyle = '#6a6458'; g.fillRect(k * 128 + 12, 62, 104, 30); }
  });
  const map = canvasTex(512, 128, (g, w, h) => {
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
  return { map, lit };
}

export function mulberry32(a: number): () => number {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// The sky dome. Its colours are uniforms the time of day sets (timeOfDay.ts skyUniforms; display space, matching the
// fog's colour at the horizon): zenith and horizon, the sun's disc and halo (the moon's at night), a warm band along
// the horizon towards a low sun (dusk), a glow low all round (a city's lights at night), cloud cover and colours,
// stars. The defaults are the plain day's. With the WEATHER define (weather.ts sets it only while it is overcast, so a
// dry sky's shader is the plain one) the uniforms uOvercast (0..1), uRain (0..1) and uFog (the fog colour, display
// space) turn it grey: the horizon is the fog's colour, the cloud closes over and the sun, moon and stars go behind it.
export function buildSky(scene: THREE.Scene, sunDir: THREE.Vector3) {
  const C = (r: number, g: number, b: number) => ({ value: new THREE.Color(r, g, b) });
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false,
    uniforms: {
      sunDir: { value: sunDir }, uOvercast: { value: 0 }, uRain: { value: 0 }, uFog: C(0.80, 0.87, 0.93),
      uZenith: C(0.28, 0.52, 0.86), uHorizon: C(0.80, 0.87, 0.93), uSunCol: C(1.0, 0.92, 0.75), uSunGlow: { value: 1 }, uSunSize: { value: 900 }, uBand: { value: 0 },
      uGlow: C(0, 0, 0), uClouds: { value: 0.5 }, uCloudLit: C(1.0, 0.99, 0.97), uCloudShade: C(0.74, 0.79, 0.86), uStars: { value: 0 },
    },
    vertexShader: `varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.); gl_Position = p.xyww; }`,
    // Clouds: value-noise fbm on a flat layer (direction projected onto a plane overhead), thinned out towards the
    // horizon so it stays hazy there. Stars: one in a few hundred cells of a grid on the direction, twinkle-free.
    fragmentShader: `varying vec3 vDir; uniform vec3 sunDir;
      uniform vec3 uZenith, uHorizon, uSunCol, uGlow, uCloudLit, uCloudShade; uniform float uSunGlow, uSunSize, uBand, uClouds, uStars;
      #ifdef WEATHER
      uniform float uOvercast, uRain; uniform vec3 uFog;
      #endif
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float hash3(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
      float fbm(vec2 p){ float v = 0., a = 0.5; for (int k = 0; k < 5; k++) { v += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return v; }
      void main(){ vec3 d = normalize(vDir); float h = clamp(d.y, 0., 1.);
        #ifdef WEATHER
        float clear = 1. - uOvercast;
        vec3 horizon = uFog, zenith = mix(uZenith, uFog, 0.5 * uOvercast);
        #else
        float clear = 1.;
        vec3 horizon = uHorizon, zenith = uZenith;
        #endif
        vec3 col = mix(horizon, zenith, pow(h, 0.55));
        vec3 sd = normalize(sunDir);
        float s = max(dot(d, sd), 0.);
        // dusk: warm low down towards the sun; night: a city's glow all round the horizon
        float toward = 0.5 + 0.5 * dot(normalize(d.xz + vec2(1e-5)), normalize(sd.xz + vec2(1e-5)));
        col += (uSunCol * uBand * toward * toward * 0.55 * exp(-h * 7.) + uGlow * exp(-h * 10.)) * clear;
        float cloud = 0.;
        if (d.y > 0.) {
          vec2 uv = d.xz / (d.y + 0.12) * 1.6;
          // stars, behind the cloud
          if (uStars > 0.) {
            vec3 p = d * 160.; vec3 c = floor(p); float r = hash3(c);
            float st = step(0.985, r) * smoothstep(0.42, 0.05, length(fract(p) - 0.5 - 0.3 * (vec3(hash3(c + 1.7), hash3(c + 3.1), hash3(c + 5.3)) - 0.5)));
            col += vec3(0.85, 0.88, 1.0) * st * (0.35 + 0.65 * fract(r * 97.)) * uStars * smoothstep(0.05, 0.3, d.y) * clear;
          }
          float lo = mix(0.64, 0.36, uClouds);
          float c = smoothstep(lo, lo + 0.28, fbm(uv + vec2(3.7, 1.2)));
          c *= smoothstep(0.02, 0.22, d.y);
          float shade = 0.82 + 0.18 * fbm(uv * 1.7 + 5.);            // lumpy undersides
          vec3 cl = mix(uCloudShade, uCloudLit, shade) + uSunCol * pow(s, 8.) * 0.25 * uSunGlow;
          col = mix(col, cl, c * 0.85);
          cloud = c;
          #ifdef WEATHER
          // Overcast: one grey deck, darker and lumpier the heavier the rain. Low down it is exactly the fog's colour:
          // anything far off (a city skyline) is fogged to that colour too, and must not stand out against the sky.
          float n = fbm(uv * 0.55 + vec2(1.3, 7.1) + 0.6 * vec2(fbm(uv * 0.3), 0.));
          vec3 deck = uFog * (1.03 - 0.08 * h) * mix(1.0, 0.72 + 0.5 * n, 0.5 + 0.5 * uRain);
          col = mix(col, mix(deck, uFog, 1. - smoothstep(0.14, 0.5, d.y)), uOvercast);
          #endif
        }
        col += uSunCol * (pow(s, uSunSize) * 6. * (1. - 0.8 * cloud) + pow(s, 12.) * 0.18 * uSunGlow) * clear * clear;
        if (d.y < 0.) col = horizon * mix(1.0, 0.85, clamp(-d.y * 4., 0., 1.));
        gl_FragColor = vec4(col, 1.); }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 32, 16), mat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);
  return sky;
}
