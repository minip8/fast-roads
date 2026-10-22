import * as THREE from 'three';
import { buildSpeedProfile } from './autopilot.js';
import { CARS } from './cars.js';
import { KERB_W } from './config.js';
import { canvasTex } from './textures.js';
import { pointAt } from './track.js';
import { wrapI } from './util.js';

// Brake markers: 300/200/100 m boards before every big braking zone, counting down to where braking ends
// (the turn-in point). Zones come from the autopilot's speed plan.
export function findBrakeZones(tr) {
  const v = buildSpeedProfile(tr, CARS.f1), N = tr.N, zones = [];   // boards are scenery: placed for the F1
  const braking = (i) => v[(i + 1) % N] < v[i] - 1e-3;
  let start = 0;
  while (braking(start)) start++;                 // begin outside a braking run
  for (let k = 0; k < N; k++) {
    const a = (start + k) % N;
    if (!braking(a) || braking(wrapI(a - 1, N))) continue;          // a = first braking sample of a run
    let b = a;
    while (braking((b + 1) % N)) b = (b + 1) % N;
    const entry = (b + 1) % N;
    const drop = (v[a] - v[entry]) * 3.6;
    if (drop > 50) zones.push({ entry, s: tr.S[entry], fromKmh: Math.round(v[a] * 3.6), toKmh: Math.round(v[entry] * 3.6) });
  }
  return zones.sort((p, q) => p.s - q.s);
}

export function buildBrakeMarkers(tr, scene) {
  const zones = findBrakeZones(tr), markers = [];
  const tex = {};
  for (const d of [100, 200, 300]) {
    tex[d] = canvasTex(256, 192, (g, w, h) => {
      g.fillStyle = '#f4f4f0'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#d8262b'; g.fillRect(0, 0, w, 14); g.fillRect(0, h - 14, w, 14);
      g.fillStyle = '#111'; g.font = 'bold 120px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(d), w / 2, h / 2 + 6);
    }, { repeat: false });
  }
  const boardGeo = new THREE.BoxGeometry(1.8, 1.35, 0.08);
  const postGeo = new THREE.BoxGeometry(0.1, 0.65, 0.1).translate(0, 0.325, 0);
  const plain = new THREE.MeshStandardMaterial({ color: 0xe8e8e4, roughness: 0.7 });
  const postMat = new THREE.MeshStandardMaterial({ color: 0x444a52, roughness: 0.6, metalness: 0.4 });
  const faceMat = {};
  for (const d in tex) faceMat[d] = new THREE.MeshStandardMaterial({ map: tex[d], roughness: 0.6 });
  zones.forEach((z, zi) => {
    const prevEntry = zones.length > 1 ? zones[wrapI(zi - 1, zones.length)].s : -Infinity;
    // the side the car approaches on: the outside of the corner it is about to turn into
    const side = tr.KS[z.entry] > 0 ? -1 : 1;
    for (const d of [100, 200, 300]) {
      let sb = z.s - d;
      // only on the stretch after the previous corner (otherwise boards from two corners interleave)
      const fwd = (x) => ((x % tr.L) + tr.L) % tr.L;
      if (zones.length > 1 && (fwd(sb - prevEntry) > fwd(z.s - prevEntry) || fwd(sb - prevEntry) < 40)) continue;
      const p = pointAt(tr, sb), i = p.i;
      if (Math.abs(tr.KS[i]) > 1 / 250) continue;                   // don't plant boards mid-bend
      const edge = side > 0 ? tr.WL[i] : tr.WR[i], bar = side > 0 ? tr.barL[i] : tr.barR[i];
      const off = Math.min(edge + KERB_W + 2.2, bar - 1.2);
      const q = pointAt(tr, sb, side * off);
      const g = new THREE.Group();
      const board = new THREE.Mesh(boardGeo, [plain, plain, plain, plain, faceMat[d], plain]);   // +z face shows the number
      board.position.y = 1.3; board.castShadow = true;
      const post = new THREE.Mesh(postGeo, postMat);
      g.add(board, post);
      g.position.set(q.x, 0, q.z);
      // face the oncoming car: local +z points back along the track (-tangent)
      g.rotation.y = Math.atan2(-tr.TX[i], -tr.TZ[i]);
      scene.add(g);
      markers.push({ d, s: Math.round(((sb % tr.L) + tr.L) % tr.L), side, entryS: Math.round(z.s), fromKmh: z.fromKmh, toKmh: z.toKmh });
    }
  });
  return { zones, markers };
}
