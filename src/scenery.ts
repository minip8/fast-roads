import * as THREE from 'three';
import { Batch } from './batch';
import { canvasTex, noiseFill } from './textures';
import { clamp, wrapI } from './util';
import type { Track } from './track';

// ============================================================================
// Scenery: sky, terrain, trees, grandstands, skyline, gantry
// ============================================================================
export function buildScenery(tr: Track, scene: THREE.Scene) {
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
  const terrain = new THREE.Mesh(tg, new THREE.MeshStandardMaterial({ map: grassTex, vertexColors: true, roughness: 1 }));
  terrain.position.set(cx, -0.03, cz);
  terrain.receiveShadow = true;
  scene.add(terrain);

  // Trees (instanced)
  const rng = mulberry32(1337);
  const treePos = [];
  for (let tries = 0; tries < 7000 && treePos.length < 1800; tries++) {
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

  // Distant city skyline (north, i.e. -z)
  const bGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const bCount = 160;
  const blds = new THREE.InstancedMesh(bGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.2 }), bCount);
  for (let k = 0; k < bCount; k++) {
    const x = cx - 900 + rng() * 1900, z = minZ - 1900 - rng() * 1300;
    const h = 30 + Math.pow(rng(), 2.2) * 230, w = 25 + rng() * 45;
    mtx.compose(pos.set(x, 0, z), q.identity(), sc.set(w, h, 25 + rng() * 45));
    blds.setMatrixAt(k, mtx);
    blds.setColorAt(k, tmp.set([0x9aa6b2, 0xb7c0c8, 0x7f8c99, 0xc9ced3][k % 4]));
  }
  scene.add(blds);

  // Grandstands along the right side of the main straight, pit building on the left
  const standMats = {
    concrete: new THREE.MeshStandardMaterial({ color: 0xb9b6ae, roughness: 0.9 }),
    crowd: new THREE.MeshStandardMaterial({ map: canvasTex(256, 64, (g, w, h) => {
      g.fillStyle = '#2b3442'; g.fillRect(0, 0, w, h);
      for (let k = 0; k < 900; k++) { g.fillStyle = `hsl(${Math.random() * 360},${40 + Math.random() * 40}%,${40 + Math.random() * 35}%)`; g.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
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
  const stepI = Math.round(26 / (tr.L / tr.N));
  for (let k = -16; k <= 3; k++) {
    const i = wrapI(k * stepI, tr.N);
    if (!tr.barRValid[i] || Math.abs(tr.KS[i]) > 1 / 600) continue;
    const off = -(tr.barR[i] + 4);
    // local +z points to track centre (left normal)
    M.compose(pos.set(tr.X[i] + tr.NX[i] * off, 0, tr.Z[i] + tr.NZ[i] * off), q.setFromEuler(e.set(0, Math.atan2(tr.NX[i], tr.NZ[i]), 0)), sc.set(1, 1, 1));
    for (let t = 0; t < 5; t++) part(tierGeo, 0, 0.6 + t * 1.2, -t * 2.2, tierMats);
    part(backGeo, 0, 4.5, -10.2, standMats.concrete);
    part(roofGeo, 0, 9.2, -4.5, standMats.roof);
    for (const x of [-11.5, 11.5]) part(postGeo, x, 4.5, 1.5, standMats.concrete);
  }
  // Pit building
  {
    const i0 = wrapI(-110, tr.N), i1 = wrapI(40, tr.N);
    const a = { x: tr.X[i0], z: tr.Z[i0] }, b = { x: tr.X[i1], z: tr.Z[i1] };
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const im = wrapI(-35, tr.N), off = tr.barL[im] + 9;
    M.compose(pos.set(tr.X[im] + tr.NX[im] * off, 4, tr.Z[im] + tr.NZ[im] * off), q.setFromEuler(e.set(0, Math.atan2(b.x - a.x, b.z - a.z), 0)), sc.set(1, 1, 1));
    part(new THREE.BoxGeometry(12, 8, len), 0, 0, 0, [standMats.concrete, standMats.concrete, standMats.roof, standMats.concrete, standMats.concrete, standMats.concrete]);
  }
  // Start gantry: local x maps to the left normal, rotation.y = atan2(-NZ, NX) maps (1,0,0) -> (NX, 0, NZ)
  {
    const m = new THREE.MeshStandardMaterial({ color: 0x2a2e35, roughness: 0.5, metalness: 0.6 });
    const lamp = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0x330000 });
    const wl = tr.WL[0] + 2, wr = tr.WR[0] + 2;
    M.compose(pos.set(tr.X[0], 0, tr.Z[0]), q.setFromEuler(e.set(0, Math.atan2(-tr.NZ[0], tr.NX[0]), 0)), sc.set(1, 1, 1));
    const gpost = new THREE.BoxGeometry(0.5, 7, 0.5);
    for (const o of [wl, -wr]) part(gpost, o, 3.5, 0, m);
    part(new THREE.BoxGeometry(wl + wr, 0.9, 0.6), (wl - wr) / 2, 6.8, 0, m);
    const lampGeo = new THREE.BoxGeometry(0.5, 0.5, 0.2);
    for (let k = 0; k < 5; k++) part(lampGeo, -1.4 + k * 0.7, 6.8, 0.35, lamp);
  }
  batch.build(scene);
  return { cx, cz, minX, maxX, minZ, maxZ };
}

export function mulberry32(a: number): () => number {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function buildSky(scene: THREE.Scene, sunDir: THREE.Vector3) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false,
    uniforms: { sunDir: { value: sunDir } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.); gl_Position = p.xyww; }`,
    fragmentShader: `varying vec3 vDir; uniform vec3 sunDir;
      void main(){ vec3 d = normalize(vDir); float h = clamp(d.y, 0., 1.);
        vec3 horizon = vec3(0.80, 0.87, 0.93), zenith = vec3(0.28, 0.52, 0.86);
        vec3 col = mix(horizon, zenith, pow(h, 0.55));
        float s = max(dot(d, normalize(sunDir)), 0.);
        col += vec3(1.0, 0.92, 0.75) * (pow(s, 900.) * 6. + pow(s, 12.) * 0.18);
        if (d.y < 0.) col = horizon * mix(1.0, 0.85, clamp(-d.y * 4., 0., 1.));
        gl_FragColor = vec4(col, 1.); }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 32, 16), mat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);
  return sky;
}
