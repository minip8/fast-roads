import * as THREE from 'three';
import { PIT, type PitLane } from './raceGeometry';
import { canvasTex, noiseFill } from './textures';
import type { Track } from './track';
import { lerp, wrapI } from './util';

// ============================================================================
// The pit lane drawn (raceGeometry.ts has its shape): a darker strip of asphalt from the track's edge to the lane's
// outer edge, the pit-lane line (solid white: tapering in from the track's edge over the entry ramp, along the lane's
// inner edge, back out over the exit ramp) and the outer edge line, the speed-limit lines across the lane, the box
// (yellow, with BOX painted in it) and boards on posts at the far side: PIT IN, the limit at each limit line, PIT
// OUT. One group, added in a room only (the time trial has no pit lane); dispose() frees it.
// ============================================================================
const Y = { lane: 0.003, paint: 0.006 };

export class PitLaneMesh {
  readonly group = new THREE.Group();
  private readonly owned: { dispose(): void }[] = [];

  constructor(private readonly tr: Track, private readonly lane: PitLane) {
    const L = lane, ds = tr.L / tr.N, n = L.n, rampIn = Math.round(L.limIn / ds), rampOut = Math.round(L.limOut / ds);
    const tex = canvasTex(256, 256, (g, w, h) => noiseFill(g, w, h, [70, 72, 76], 22, 0.02));
    const laneMat = this.mat(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 }));
    const white = this.mat(new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.7 }));
    const yellow = this.mat(new THREE.MeshStandardMaterial({ color: 0xffd23f, roughness: 0.7 }));
    // the line between the track and the lane: from the track's edge to the inner edge over the entry ramp, back over the exit
    const lineX = (k: number) => k < rampIn ? lerp(L.edge[k], L.inner[k], k / rampIn)
      : k > rampOut ? lerp(L.inner[k], L.edge[k], (k - rampOut) / Math.max(1, n - 1 - rampOut)) : L.inner[k];
    this.strip(0, n - 1, (k) => L.edge[k], (k) => L.outer[k], Y.lane, laneMat, 1 / 8);
    this.strip(0, n - 1, (k) => lineX(k) - 0.12, (k) => lineX(k) + 0.12, Y.paint, white);
    this.strip(0, n - 1, (k) => L.outer[k] - 0.15, (k) => L.outer[k], Y.paint, white);
    // the limit lines across the lane, 0.4 m deep
    for (const d of [L.limIn, L.limOut]) {
      const k = Math.round(d / ds);
      this.strip(k, k + 1, (j) => L.inner[j], (j) => L.outer[j], Y.paint, white, 1, 0.4 / ds);
    }
    // the box: an outline and BOX painted in it
    const b0 = Math.round((L.box - PIT.boxLen / 2) / ds), b1 = Math.round((L.box + PIT.boxLen / 2) / ds);
    this.strip(b0, b1, (k) => L.inner[k] + 0.3, (k) => L.inner[k] + 0.55, Y.paint, yellow);
    this.strip(b0, b1, (k) => L.outer[k] - 0.55, (k) => L.outer[k] - 0.3, Y.paint, yellow);
    for (const k of [b0, b1]) this.strip(k, k + 1, (j) => L.inner[j] + 0.3, (j) => L.outer[j] - 0.3, Y.paint, yellow, 1, 0.25 / ds);
    const boxTex = canvasTex(256, 512, (g, w, h) => {
      g.clearRect(0, 0, w, h); g.fillStyle = '#ffd23f'; g.font = 'bold 150px system-ui, sans-serif'; g.textAlign = 'center';
      g.save(); g.translate(w / 2, h / 2); g.rotate(Math.PI / 2); g.fillText('BOX', 0, 52); g.restore();
    }, { repeat: false });
    const boxMat = this.mat(new THREE.MeshBasicMaterial({ map: boxTex, transparent: true, depthWrite: false, toneMapped: false }));
    this.strip(b0 + 2, b1 - 2, (k) => L.inner[k] + 0.8, (k) => L.outer[k] - 0.8, Y.paint + 0.001, boxMat, 1, 1, true);
    // boards at the far side, facing the cars coming
    const kmh = Math.round(L.limitMs * 3.6);
    this.board(0, 'PIT IN', '#ffffff', '#1e6fd9');
    this.board(rampIn, `${kmh}`, '#111', '#fff', true);
    this.board(rampOut, `${kmh}`, '#111', '#fff', true, true);
    this.board(n - 1, 'PIT OUT', '#ffffff', '#1e6fd9');
  }

  dispose() {
    this.group.removeFromParent();
    for (const o of this.owned) o.dispose();
  }

  // ------------------------------------------------------------------------
  private mat<M extends THREE.Material>(m: M): M { this.owned.push(m); if ('map' in m && m.map) this.owned.push(m.map as THREE.Texture); return m; }

  private at(k: number, x: number, y: number, out: number[]) {
    const tr = this.tr, i = wrapI(this.lane.k0 + k, tr.N), o = x * this.lane.side;
    out.push(tr.X[i] + tr.NX[i] * o, y, tr.Z[i] + tr.NZ[i] * o);
  }

  // A strip over lane samples k0..k1 between offsets a(k) and b(k) (side x lat). vScale: texture v per sample; uvBox:
  // the texture spread over the whole strip once (u across, v along).
  private strip(k0: number, k1: number, a: (k: number) => number, b: (k: number) => number, y: number, mat: THREE.Material, vScale = 1 / 8, depth = 1, uvBox = false) {
    const n = this.lane.n, pos: number[] = [], uv: number[] = [], idx: number[] = [];
    k0 = Math.max(0, k0); k1 = Math.min(n - 1, k1);
    if (k1 <= k0) return;
    const ds = this.tr.L / this.tr.N;
    for (let k = k0; k <= k1; k++) {
      // the last column of a thin strip (depth < 1 sample) stops short
      const kk = depth < 1 && k === k1 ? k0 + depth : k, kf = Math.min(n - 1, Math.floor(kk)), f = kk - kf, kn = Math.min(n - 1, kf + 1);
      const ax = lerp(a(kf), a(kn), f), bx = lerp(b(kf), b(kn), f);
      if (f === 0) { this.at(kf, ax, y, pos); this.at(kf, bx, y, pos); }
      else { const p: number[] = [], q: number[] = []; this.at(kf, ax, y, p); this.at(kn, ax, y, q); pos.push(...p.map((v, j) => lerp(v, q[j], f))); const r: number[] = [], t: number[] = []; this.at(kf, bx, y, r); this.at(kn, bx, y, t); pos.push(...r.map((v, j) => lerp(v, t[j], f))); }
      const v = uvBox ? (k - k0) / (k1 - k0) : (k - k0) * ds * vScale;
      uv.push(0, v, uvBox ? 1 : (bx - ax) * vScale, v);
      if (k < k1) { const c = (k - k0) * 2; idx.push(c, c + 2, c + 1, c + 1, c + 2, c + 3); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(this.lane.side > 0 ? idx : idx.map((_, j) => idx[j - (j % 3) + [0, 2, 1][j % 3]]));
    geo.computeVertexNormals();
    this.owned.push(geo);
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true;
    this.group.add(m);
  }

  // A board on two posts just beyond the lane's outer edge at lane sample k, facing the cars coming; round: a speed
  // limit sign, struck through at its end (end).
  private board(k: number, text: string, fg: string, bg: string, round = false, end = false) {
    const tr = this.tr, i = wrapI(this.lane.k0 + Math.max(0, Math.min(this.lane.n - 1, k)), tr.N);
    const tex = canvasTex(256, 128, (g, w, h) => {
      g.fillStyle = bg; g.fillRect(0, 0, w, h);
      if (round) { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.strokeStyle = '#d8262b'; g.lineWidth = 12; g.beginPath(); g.arc(w / 2, h / 2, 52, 0, Math.PI * 2); g.stroke(); }
      g.fillStyle = fg; g.font = `bold ${round ? 56 : 54}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(text, w / 2, h / 2 + 2);
      if (end) { g.strokeStyle = '#111'; g.lineWidth = 10; g.beginPath(); g.moveTo(w / 2 - 40, h / 2 + 40); g.lineTo(w / 2 + 40, h / 2 - 40); g.stroke(); }
    }, { repeat: false });
    const face = this.mat(new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    const post = this.mat(new THREE.MeshStandardMaterial({ color: 0x2a2e35, roughness: 0.6, metalness: 0.5 }));
    const g = new THREE.Group(), o = (this.lane.outer[Math.max(0, Math.min(this.lane.n - 1, k))] + 0.35) * this.lane.side;
    g.position.set(tr.X[i] + tr.NX[i] * o, 0, tr.Z[i] + tr.NZ[i] * o);
    g.rotation.y = Math.atan2(tr.TX[i], tr.TZ[i]) + Math.PI;   // the face (+z of the plane) towards the cars
    const pg = new THREE.BoxGeometry(0.08, 1.6, 0.08), fg2 = new THREE.PlaneGeometry(1.6, 0.8);
    this.owned.push(pg, fg2);
    for (const x of [-0.6, 0.6]) { const p = new THREE.Mesh(pg, post); p.position.set(x, 0.8, 0); g.add(p); }
    const f = new THREE.Mesh(fg2, face); f.position.y = 1.6 + 0.4; g.add(f);
    const backM = new THREE.Mesh(fg2, post); backM.position.y = 2; backM.rotation.y = Math.PI; g.add(backM);
    this.group.add(g);
  }
}
