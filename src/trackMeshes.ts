import * as THREE from 'three';
import { GRAVEL_W, KERB_W } from './config';
import { canvasTex, noiseFill } from './textures';
import type { Track } from './track';

// ============================================================================
// Track meshes
// ============================================================================
// Columns are ordered by increasing lateral offset. A column with `cut: true` emits no face between it and the next.
export interface RibbonCol {
  o: (i: number) => number;               // lateral offset at sample i
  y: number | ((i: number) => number);    // height
  u: number | ((i: number) => number);    // texture u
  cut?: boolean;
}
// `shade` (optional) gives a grey vertex colour per sample and column (the material needs vertexColors).
export function ribbon(tr: Track, cols: RibbonCol[], { mask = null, vScale = 1, material, shade }:
  { mask?: Uint8Array | null; vScale?: number; material: THREE.Material; shade?: (i: number, c: number) => number }) {
  const N = tr.N, C = cols.length;
  const pos = new Float32Array((N + 1) * C * 3), uv = new Float32Array((N + 1) * C * 2);
  const rgb = shade ? new Float32Array((N + 1) * C * 3) : null;
  for (let i = 0; i <= N; i++) {
    const k = i % N, s = i === N ? tr.L : tr.S[k];
    for (let c = 0; c < C; c++) {
      const col = cols[c], o = col.o(k);
      const y = typeof col.y === 'function' ? col.y(k) : col.y;
      const u = typeof col.u === 'function' ? col.u(k) : col.u;
      const v = i * C + c;
      pos[v * 3] = tr.X[k] + tr.NX[k] * o; pos[v * 3 + 1] = y; pos[v * 3 + 2] = tr.Z[k] + tr.NZ[k] * o;
      uv[v * 2] = u; uv[v * 2 + 1] = s * vScale;
      if (rgb) rgb.fill(shade!(k, c), v * 3, v * 3 + 3);
    }
  }
  const index: number[] = [];
  for (let i = 0; i < N; i++) {
    if (mask && !(mask[i] && mask[(i + 1) % N])) continue;
    for (let c = 0; c < C - 1; c++) {
      if (cols[c].cut) continue;
      const a = i * C + c, b = a + 1, a1 = a + C, b1 = b + C;
      index.push(a, a1, b, b, a1, b1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (rgb) geo.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  return mesh;
}

export function buildTrackMeshes(tr: Track, scene: THREE.Scene) {
  const asphaltTex = canvasTex(512, 512, (g, w, h) => {
    noiseFill(g, w, h, [58, 60, 64], 26, 0.02);
    // soft darker/lighter patches (wear, repairs), so the road isn't one flat grey once mipmapped in the distance
    for (let k = 0; k < 40; k++) {
      const x = Math.random() * w, y = Math.random() * h, r = 20 + Math.random() * 70, dark = Math.random() < 0.55;
      for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) {   // wrapped, so the tile stays seamless
        const grd = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        grd.addColorStop(0, dark ? 'rgba(20,22,26,0.1)' : 'rgba(150,150,150,0.05)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd; g.fillRect(x + ox - r, y + oy - r, 2 * r, 2 * r);
      }
    }
  });
  const roadMat = new THREE.MeshStandardMaterial({ map: asphaltTex, vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
  // Large-scale shading the 8 m texture tile can't give: slow light/dark bands along the lap (resurfaced
  // stretches) and a slightly darker, rubbered middle.
  const along = (i: number) => { const s = tr.S[i]; return 0.93 + 0.035 * Math.sin(s / 41) + 0.025 * Math.sin(s / 97 + 1.7) + 0.02 * Math.sin(s / 13.3 + 0.4); };
  const road = ribbon(tr, [
    { o: (i) => -tr.WR[i], y: 0, u: (i) => -tr.WR[i] / 8 },
    { o: () => 0, y: 0, u: 0 },
    { o: (i) => tr.WL[i], y: 0, u: (i) => tr.WL[i] / 8 },
  ], { vScale: 1 / 8, material: roadMat, shade: (i, c) => along(i) * (c === 1 ? 0.9 : 1.04) });
  scene.add(road);

  const lineMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.7, side: THREE.DoubleSide });
  scene.add(ribbon(tr, [{ o: (i) => tr.WL[i] - 0.22, y: 0.004, u: 0 }, { o: (i) => tr.WL[i] - 0.02, y: 0.004, u: 1 }], { material: lineMat }));
  scene.add(ribbon(tr, [{ o: (i) => -tr.WR[i] + 0.02, y: 0.004, u: 0 }, { o: (i) => -tr.WR[i] + 0.22, y: 0.004, u: 1 }], { material: lineMat }));

  const kerbTex = canvasTex(4, 64, (g) => { g.fillStyle = '#d8262b'; g.fillRect(0, 0, 4, 32); g.fillStyle = '#f5f5f2'; g.fillRect(0, 32, 4, 32); }, { nearest: true });
  const kerbMat = new THREE.MeshStandardMaterial({ map: kerbTex, roughness: 0.6, side: THREE.DoubleSide });
  const kv = 1 / 3;   // stripes 1.5 m
  scene.add(ribbon(tr, [
    { o: (i) => tr.WL[i], y: 0.006, u: 0 }, { o: (i) => tr.WL[i] + 0.35, y: 0.045, u: 0.3 }, { o: (i) => tr.WL[i] + KERB_W, y: 0.03, u: 1 },
  ], { mask: tr.kerbL, vScale: kv, material: kerbMat }));
  scene.add(ribbon(tr, [
    { o: (i) => -tr.WR[i] - KERB_W, y: 0.03, u: 1 }, { o: (i) => -tr.WR[i] - 0.35, y: 0.045, u: 0.3 }, { o: (i) => -tr.WR[i], y: 0.006, u: 0 },
  ], { mask: tr.kerbR, vScale: kv, material: kerbMat }));

  const gravelTex = canvasTex(256, 256, (g, w, h) => noiseFill(g, w, h, [196, 178, 140], 50, 0.05));
  const gravelMat = new THREE.MeshStandardMaterial({ map: gravelTex, roughness: 1, side: THREE.DoubleSide });
  scene.add(ribbon(tr, [
    { o: (i) => tr.WL[i] + 0.1, y: -0.012, u: 0 },
    { o: (i) => Math.min(tr.WL[i] + KERB_W + GRAVEL_W, tr.barL[i] - 0.4), y: -0.012, u: 4 },
  ], { mask: tr.gravelL, vScale: 1 / 6, material: gravelMat }));
  scene.add(ribbon(tr, [
    { o: (i) => -Math.min(tr.WR[i] + KERB_W + GRAVEL_W, tr.barR[i] - 0.4), y: -0.012, u: 4 },
    { o: (i) => -tr.WR[i] - 0.1, y: -0.012, u: 0 },
  ], { mask: tr.gravelR, vScale: 1 / 6, material: gravelMat }));

  // Start/finish: chequered strip across the road at s = 0
  const chkTex = canvasTex(16, 2, (g) => { for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) { g.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4'; g.fillRect(x, y, 1, 1); } }, { nearest: true });
  const chkMask = new Uint8Array(tr.N); chkMask[0] = 1; chkMask[1] = 1;
  scene.add(ribbon(tr, [{ o: (i) => -tr.WR[i], y: 0.005, u: 0 }, { o: (i) => tr.WL[i], y: 0.005, u: 1 }],
    { mask: chkMask, vScale: 1 / (tr.S[1] * 1), material: new THREE.MeshStandardMaterial({ map: chkTex, roughness: 0.7, side: THREE.DoubleSide }) }));

  // Barriers: concrete wall with painted top band
  const wallTex = canvasTex(64, 128, (g, w, h) => {
    noiseFill(g, w, h, [178, 178, 172], 18);
    g.fillStyle = '#1d4f9e'; g.fillRect(30, 0, 30, h);
    g.fillStyle = '#e9eef5'; for (let y = 0; y < h; y += 32) g.fillRect(36, y + 6, 18, 18);
    g.fillStyle = '#2a2a2a'; g.fillRect(60, 0, 4, h);
  });
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.85, side: THREE.DoubleSide });
  const capMat = new THREE.MeshStandardMaterial({ color: 0x9a9a94, roughness: 0.9, side: THREE.DoubleSide });
  for (const side of [1, -1]) {
    const off = side > 0 ? tr.barL : tr.barR, valid = side > 0 ? tr.barLValid : tr.barRValid;
    const o = (d: number) => (i: number) => side * (off[i] + d);
    const wall = ribbon(tr, [{ o: o(0), y: 0, u: 0 }, { o: o(0), y: 1.0, u: 1 }], { mask: valid, vScale: 1 / 6, material: wallMat });
    const cap = ribbon(tr, [{ o: o(0), y: 1.0, u: 0 }, { o: o(0.5), y: 1.0, u: 1, cut: true }, { o: o(0.5), y: 1.0, u: 0 }, { o: o(0.5), y: 0, u: 1 }],
      { mask: valid, material: capMat });
    wall.castShadow = true; cap.castShadow = true;
    scene.add(wall, cap);
  }
  return { road, roadMat, lineMat, kerbMat, gravelMat, wallMat };
}
