import * as THREE from 'three';
import { LANE, lanePoint, laneGate, laneLapS, laneValue, sampleAt, type PitLane } from './pitLane';
import { PIT } from './raceGeometry';
import { canvasTex, noiseFill } from './textures';
import { pointAt, type Track } from './track';

// ============================================================================
// The pit lane drawn (pitLane.ts has its shape), part of the circuit in every mode: its road (where it is off the
// track's), the white line along the fast lane's track side and at its far edge, a dashed line between the fast lane
// and the working lane along the garages, the limit lines across it and the timing line where the start/finish line
// crosses it, the box (yellow, BOX painted in it, under a gantry with a lit BOX sign facing the cars coming), the pit
// wall (concrete with a debris fence on top; where it is also the track's barrier, trackMeshes.ts draws its concrete)
// and the far wall. The way in: countdown boards on the pit side before the lane leaves the track (PIT 300, 200,
// 100), white chevrons on a blue band along the track's edge for the last ENTRY_PAINT m, blue hatching over the gore
// between the track and the lane to the pit wall's nose, the PIT IN board; the limit boards at the limit lines; PIT
// OUT and the hatching over the exit's gore. One group; dispose() frees it.
// ============================================================================
const Y = { lane: 0.003, paint: 0.007 };
const ENTRY_PAINT = 120;              // m of chevrons along the track's edge before the lane leaves it
const COUNTDOWN = [300, 200, 100];    // m before the lane leaves the track: the entry's countdown boards
const STEP = 1;                       // m between a strip's rows
const WALL_H = 1.0, FENCE_H = 2.4;    // m: the pit wall and far wall's height, the debris fence's on top of the pit wall

export class PitLaneMesh {
  readonly group = new THREE.Group();
  private readonly owned: { dispose(): void }[] = [];
  private readonly half = LANE.fast / 2;

  constructor(private readonly tr: Track, private readonly lane: PitLane) {
    const L = lane, half = this.half;
    const tex = canvasTex(256, 256, (g, w, h) => noiseFill(g, w, h, [74, 76, 80], 22, 0.02));
    const laneMat = this.mat(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    const white = this.mat(new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    const yellow = this.mat(new THREE.MeshStandardMaterial({ color: 0xffd23f, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    // the road: the lane's, off the track's (its first and last metres run on the track's road)
    const trackSide = (d: number) => -Math.min(this.wIn(d), Math.max(-L.wOut[sampleAt(L, d)], this.sep(d) - 0.05));
    this.strip(0, L.len, trackSide, (d) => this.wOut(d), Y.lane, laneMat, 1 / 8);
    // lines: along the fast lane's track side (from where it leaves the track's road), its far edge, and the fast lane
    // from the working lane (dashed) along the working stretch
    const off = (d: number) => this.sep(d) > half + 0.2;
    this.strip(0, L.len, () => -half, () => -half + 0.2, Y.paint, white, 1, (d) => off(d));
    this.strip(0, L.len, (d) => this.wOut(d) - 0.2, (d) => this.wOut(d), Y.paint, white, 1, (d) => this.sep(d) > -this.wOut(d) + 0.5);
    this.strip(L.work[0], L.work[1], () => half - 0.08, () => half + 0.08, Y.paint, white, 1, (d) => (d - L.work[0]) % 6 < 3);
    // the limit lines across the lane, 0.4 m deep, and the start/finish line where the lane passes it (chequered)
    for (const d of [L.limIn, L.limOut]) this.strip(d, d + 0.4, (x) => -this.wIn(x), (x) => this.wOut(x), Y.paint, white);
    const gate = laneGate(L, tr.L, 0);
    if (gate) {
      const chk = canvasTex(16, 2, (g) => { for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) { g.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f0'; g.fillRect(x, y, 1, 1); } }, { nearest: true });
      const chkMat = this.mat(new THREE.MeshStandardMaterial({ map: chk, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      const d = this.dOf(gate.seg.ax, gate.seg.az);
      this.strip(d, d + 0.6, (x) => -this.wIn(x), (x) => this.wOut(x), Y.paint, chkMat, 1, undefined, true);
    }
    // the box: an outline in the working lane, filled faintly, BOX painted in it
    const b0 = L.box - PIT.boxLen / 2, b1 = L.box + PIT.boxLen / 2, bi = L.boxOff - PIT.boxWidth / 2 + 0.3, bo = L.boxOff + PIT.boxWidth / 2 - 0.3;
    this.strip(b0, b1, () => bi, () => bi + 0.25, Y.paint, yellow);
    this.strip(b0, b1, () => bo - 0.25, () => bo, Y.paint, yellow);
    for (const d of [b0, b1 - 0.25]) this.strip(d, d + 0.25, () => bi, () => bo, Y.paint, yellow);
    const fill = this.mat(new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.22, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    this.strip(b0 + 0.25, b1 - 0.25, () => bi + 0.25, () => bo - 0.25, Y.paint - 0.001, fill);
    const boxTex = canvasTex(256, 512, (g, w, h) => {
      g.clearRect(0, 0, w, h); g.fillStyle = '#ffd23f'; g.font = 'bold 150px system-ui, sans-serif'; g.textAlign = 'center';
      g.save(); g.translate(w / 2, h / 2); g.rotate(Math.PI / 2); g.fillText('BOX', 0, 52); g.restore();
    }, { repeat: false });
    const boxMat = this.mat(new THREE.MeshBasicMaterial({ map: boxTex, transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    this.strip(b0 + 1.2, b1 - 1.2, () => bi + 0.5, () => bo - 0.5, Y.paint + 0.001, boxMat, 1, undefined, true);
    this.boxGantry(b0);
    // the way in and out: chevrons along the track's edge before the lane leaves it, hatching over the gores
    const chevTex = canvasTex(128, 128, (g, w, h) => {
      g.fillStyle = 'rgba(30,111,217,.55)'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#f4f4f0'; g.lineWidth = 14; g.lineJoin = 'miter';
      g.beginPath(); g.moveTo(14, h * 0.8); g.lineTo(w / 2, h * 0.2); g.lineTo(w - 14, h * 0.8); g.stroke();
    }, { repeat: true });
    const chevMat = this.mat(new THREE.MeshBasicMaterial({ map: chevTex, transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    const leave = this.leaves(), sLeave = laneLapS(L, tr.L, leave);
    this.trackStrip(sLeave - ENTRY_PAINT, sLeave, (e) => e - 2.6, (e) => e - 0.25, chevMat);
    const hatchTex = canvasTex(128, 128, (g, w, h) => {
      g.fillStyle = 'rgba(30,111,217,.6)'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#f4f4f0'; g.lineWidth = 12;
      for (let x = -w; x < 2 * w; x += 48) { g.beginPath(); g.moveTo(x, h); g.lineTo(x + w, 0); g.stroke(); }
    }, { repeat: true });
    const hatchMat = this.mat(new THREE.MeshBasicMaterial({ map: hatchTex, transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    const gore = (d: number) => this.wIn(d) > half + 0.3;
    this.strip(0, L.nose, (d) => -this.wIn(d) + 0.1, () => -half - 0.05, Y.paint, hatchMat, 1 / 4, gore);
    this.strip(L.tail, L.len, (d) => -this.wIn(d) + 0.1, () => -half - 0.05, Y.paint, hatchMat, 1 / 4, gore);
    // the walls: the pit wall (concrete, a debris fence on top), the far wall, the joins to the barrier
    this.walls();
    // boards: the countdown on the pit side of the track, PIT IN and the limits beyond the lane's far edge, PIT OUT
    const kmh = Math.round(L.limitMs * 3.6);
    for (const d of COUNTDOWN) this.countdownBoard(sLeave - d, d);
    this.board(Math.max(L.nose, leave) + 4, 'PIT IN', '#ffffff', '#1e6fd9', false, false, 1.4);
    this.board(L.limIn, `${kmh}`, '#111', '#fff', true);
    this.board(L.limOut, `${kmh}`, '#111', '#fff', true, true);
    this.board(L.tail - 4, 'PIT OUT', '#ffffff', '#1e6fd9');
  }

  dispose() {
    this.group.removeFromParent();
    for (const o of this.owned) o.dispose();
  }

  // ------------------------------------------------------------------------ the lane's numbers at d m along
  private at(d: number, a: Float64Array) { return laneValue(this.lane, a, d); }
  private wIn(d: number) { return this.at(d, this.lane.wIn); }
  private wOut(d: number) { return this.at(d, this.lane.wOut); }
  private sep(d: number) { return this.at(d, this.lane.sep); }
  // where the lane leaves the track's road (its path past the edge)
  private leaves() { const l = this.lane; let k = 0; while (k < l.n - 1 && l.sep[k] < 0) k++; return l.D[k]; }
  // m along the lane nearest (x, z) (a search: built once)
  private dOf(x: number, z: number) { const l = this.lane; let best = 0, bd = Infinity; for (let k = 0; k < l.n; k++) { const e = (l.X[k] - x) ** 2 + (l.Z[k] - z) ** 2; if (e < bd) { bd = e; best = k; } } return l.D[best]; }

  private mat<M extends THREE.Material>(m: M): M { this.owned.push(m); if ('map' in m && m.map) this.owned.push(m.map as THREE.Texture); return m; }
  private mesh(pos: number[], uv: number[], idx: number[], mat: THREE.Material, shadow = false) {
    if (!idx.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this.owned.push(geo);
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true; m.castShadow = shadow;
    this.group.add(m);
  }

  // A flat strip over d0..d1 along the lane between offsets a(d) and b(d) from its path (+ towards the far side), at
  // height y; v along at vScale per m (uvBox: the texture once over the whole strip); where `keep` is false, nothing.
  private strip(d0: number, d1: number, a: (d: number) => number, b: (d: number) => number, y: number, mat: THREE.Material, vScale = 1 / 8, keep?: (d: number) => boolean, uvBox = false) {
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    d0 = Math.max(0, d0); d1 = Math.min(this.lane.len, d1);
    if (d1 <= d0) return;
    const n = Math.max(1, Math.ceil((d1 - d0) / STEP));
    let row = -1;
    for (let j = 0; j <= n; j++) {
      const d = d0 + ((d1 - d0) * j) / n;
      const ok = !keep || keep(d), x0 = a(d), x1 = b(d);
      if (!ok || x1 <= x0) { row = -1; continue; }
      const p = lanePoint(this.lane, d, x0), q = lanePoint(this.lane, d, x1), c = pos.length / 3;
      pos.push(p.x, y, p.z, q.x, y, q.z);
      const v = uvBox ? (d - d0) / (d1 - d0) : (d - d0) * vScale;
      uv.push(0, v, uvBox ? 1 : (x1 - x0) * vScale, v);
      if (row >= 0) this.quad(idx, row, c);
      row = c;
    }
    this.mesh(pos, uv, idx, mat);
  }
  // two triangles from the row at index a (2 vertices) to the row at b, facing up whichever side the lane is on
  private quad(idx: number[], a: number, b: number) {
    if (this.lane.side > 0) idx.push(a, b, a + 1, a + 1, b, b + 1); else idx.push(a, a + 1, b, a + 1, b + 1, b);
  }

  // A flat strip along the track's pit-side edge from lap position s0 to s1, between a(edge) and b(edge) from the
  // middle (the edge's offset given), texture u across it once.
  private trackStrip(s0: number, s1: number, a: (edge: number) => number, b: (edge: number) => number, mat: THREE.Material) {
    const tr = this.tr, side = this.lane.side, pos: number[] = [], uv: number[] = [], idx: number[] = [];
    const n = Math.max(1, Math.ceil((s1 - s0) / STEP));
    for (let j = 0; j <= n; j++) {
      const s = s0 + ((s1 - s0) * j) / n, i = pointAt(tr, s).i, e = side > 0 ? tr.WL[i] : tr.WR[i];
      const p = pointAt(tr, s, side * a(e)), q = pointAt(tr, s, side * b(e)), c = pos.length / 3;
      pos.push(p.x, Y.paint, p.z, q.x, Y.paint, q.z);
      const v = (s - s0) / 4;
      uv.push(0, v, 1, v);
      if (j > 0) this.quad(idx, c - 2, c);
    }
    this.mesh(pos, uv, idx, mat);
  }

  // A wall along a polyline: two faces and a cap, `thick(t)` deep (t: 0..1 along it) towards `towards` (+1 the
  // polyline's left, -1 its right) from it, h high (its material double-sided); `keep(j)`: the stretch before point j.
  private wallAlong(pl: Float64Array, towards: 1 | -1, thick: (t: number) => number, h: number, mat: THREE.Material, keep?: (j: number) => boolean) {
    const pos: number[] = [], uv: number[] = [], idx: number[] = [], m = pl.length / 2;
    let along = 0;
    for (let j = 0; j < m; j++) {
      const a = Math.max(0, j - 1), b = Math.min(m - 1, j + 1);
      let tx = pl[2 * b] - pl[2 * a], tz = pl[2 * b + 1] - pl[2 * a + 1];
      const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const nx = tz * towards, nz = -tx * towards, w = thick(j / Math.max(1, m - 1));
      const x = pl[2 * j], z = pl[2 * j + 1];
      if (j > 0) along += Math.hypot(x - pl[2 * j - 2], z - pl[2 * j - 1]);
      // per row, three pairs (each face its own vertices, for flat shading): the face, the cap, the back
      const bx = x + nx * w, bz = z + nz * w;
      pos.push(x, 0, z, x, h, z, x, h, z, bx, h, bz, bx, h, bz, bx, 0, bz);
      const v = along / 6;
      uv.push(0, v, 1, v, 0, v, 1, v, 1, v, 0, v);
      if (j > 0 && (!keep || keep(j))) {
        const c = (j - 1) * 6, d = j * 6;
        for (const p of [0, 2, 4]) idx.push(c + p, d + p, c + p + 1, c + p + 1, d + p, d + p + 1);
      }
    }
    this.mesh(pos, uv, idx, mat, true);
  }

  private walls() {
    const L = this.lane, tr = this.tr, side = L.side;
    const concrete = this.mat(new THREE.MeshStandardMaterial({ map: canvasTex(64, 64, (g, w, h) => noiseFill(g, w, h, [190, 190, 184], 14)), roughness: 0.9, side: THREE.DoubleSide }));
    const fenceTex = canvasTex(64, 64, (g, w, h) => {
      g.clearRect(0, 0, w, h); g.strokeStyle = 'rgba(205,210,215,0.9)'; g.lineWidth = 2;
      for (let x = -h; x < w + h; x += 8) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x + h, h); g.stroke(); g.beginPath(); g.moveTo(x + h, 0); g.lineTo(x, h); g.stroke(); }
      g.fillStyle = '#4a5058'; g.fillRect(0, 0, 4, h);
    }, { repeat: true });
    const fence = this.mat(new THREE.MeshStandardMaterial({ map: fenceTex, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.4 }));
    // The pit wall: from its lane face, as thick as its two faces are apart, towards the track. Where the track's
    // barrier is its track face, trackMeshes.ts draws that wall already: only the fence then.
    const lf = L.walls.lane, tf = L.walls.track, m = lf.length / 2, bar = side > 0 ? tr.barL : tr.barR, valid = side > 0 ? tr.barLValid : tr.barRValid;
    const covered = new Uint8Array(m);
    for (let j = 0; j < m; j++) {
      const k = Math.min(L.n - 1, L.kNose + j), i = L.I[k];
      const lat = side * ((tf[2 * j] - tr.X[i]) * tr.NX[i] + (tf[2 * j + 1] - tr.Z[i]) * tr.NZ[i]);
      covered[j] = valid[i] && Math.abs(bar[i] - lat) < 0.2 ? 1 : 0;
    }
    const thick = (t: number) => { const j = Math.round(t * (m - 1)); return Math.max(0.02, Math.hypot(lf[2 * j] - tf[2 * j], lf[2 * j + 1] - tf[2 * j + 1])); };
    this.wallAlong(lf, -side as 1 | -1, thick, WALL_H, concrete, (j) => !covered[j] || !covered[j - 1]);
    // the fence: a screen over the wall's middle
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    let along = 0;
    for (let j = 0; j < m; j++) {
      const x = (lf[2 * j] + tf[2 * j]) / 2, z = (lf[2 * j + 1] + tf[2 * j + 1]) / 2;
      if (j > 0) along += Math.hypot(x - pos[pos.length - 6], z - pos[pos.length - 4]);
      pos.push(x, WALL_H, z, x, WALL_H + FENCE_H, z);
      uv.push(along / 2, 0, along / 2, FENCE_H / 2);
      if (j > 0 && thick(j / (m - 1)) > 0.2) idx.push(2 * j - 2, 2 * j, 2 * j - 1, 2 * j - 1, 2 * j, 2 * j + 1);
    }
    this.mesh(pos, uv, idx, fence);
    // the far wall: towards the far side, 0.5 m
    this.wallAlong(L.walls.outer, side, () => LANE.outerWall, WALL_H, concrete);
    for (const j of L.walls.joins) this.wallAlong(j, side, () => 0.3, WALL_H, concrete);
  }

  // The gantry over the box (d m along: its start): posts either side of the working lane, a lit BOX sign over it
  // facing the cars coming, 4.4 m up (seen from every camera, over the cars ahead).
  private boxGantry(d: number) {
    const L = this.lane;
    const tex = canvasTex(512, 128, (g, w, h) => {
      g.fillStyle = '#111'; g.fillRect(0, 0, w, h); g.strokeStyle = '#ffd23f'; g.lineWidth = 8; g.strokeRect(6, 6, w - 12, h - 12);
      g.fillStyle = '#ffd23f'; g.font = 'bold 84px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('▼ BOX ▼', w / 2, h / 2 + 4);
    }, { repeat: false });
    const face = this.mat(new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    const metal = this.mat(new THREE.MeshStandardMaterial({ color: 0x2a2e35, roughness: 0.6, metalness: 0.5 }));
    const a = this.half + 0.2, b = this.wOut(d) - 0.2, span = b - a, top = 4.4, p = lanePoint(L, d, (a + b) / 2);
    const g = new THREE.Group();
    g.position.set(p.x, 0, p.z);
    g.rotation.y = Math.atan2(p.tx, p.tz) + Math.PI;
    const post = new THREE.BoxGeometry(0.15, top, 0.15), beam = new THREE.BoxGeometry(span, 0.2, 0.2), sign = new THREE.PlaneGeometry(Math.min(span - 0.2, 4.4), 1.1);
    this.owned.push(post, beam, sign);
    for (const x of [-span / 2, span / 2]) { const m = new THREE.Mesh(post, metal); m.position.set(x, top / 2, 0); g.add(m); }
    const bm = new THREE.Mesh(beam, metal); bm.position.y = top; g.add(bm);
    const f = new THREE.Mesh(sign, face); f.position.set(0, top - 0.6, 0.12); g.add(f);
    const back = new THREE.Mesh(sign, metal); back.position.set(0, top - 0.6, 0.11); back.rotation.y = Math.PI; g.add(back);
    this.group.add(g);
  }

  // A countdown board on the pit side of the track at lap position s (d m before the lane leaves it), beyond the
  // edge and short of the barrier: PIT over the distance, facing the cars coming.
  private countdownBoard(s: number, d: number) {
    const tr = this.tr, L = this.lane, i = pointAt(tr, s).i;
    const bar = (L.side > 0 ? tr.barLValid[i] ? tr.barL[i] : Infinity : tr.barRValid[i] ? tr.barR[i] : Infinity);
    const x = Math.min((L.side > 0 ? tr.WL[i] : tr.WR[i]) + 2.5, bar - 0.6), p = pointAt(tr, s, L.side * x);
    const tex = canvasTex(128, 192, (g, w, h) => {
      g.fillStyle = '#1e6fd9'; g.fillRect(0, 0, w, h); g.strokeStyle = '#fff'; g.lineWidth = 6; g.strokeRect(4, 4, w - 8, h - 8);
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = 'bold 44px system-ui, sans-serif'; g.fillText('PIT', w / 2, 48);
      g.font = 'bold 60px system-ui, sans-serif'; g.fillText(String(d), w / 2, 128);
    }, { repeat: false });
    const face = this.mat(new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    const metal = this.mat(new THREE.MeshStandardMaterial({ color: 0x2a2e35, roughness: 0.6, metalness: 0.5 }));
    const g = new THREE.Group();
    g.position.set(p.x, 0, p.z);
    g.rotation.y = Math.atan2(tr.TX[i], tr.TZ[i]) + Math.PI;
    const pg = new THREE.BoxGeometry(0.1, 1.2, 0.1), fg = new THREE.PlaneGeometry(1.0, 1.5);
    this.owned.push(pg, fg);
    const post = new THREE.Mesh(pg, metal); post.position.y = 0.6; g.add(post);
    const f = new THREE.Mesh(fg, face); f.position.set(0, 1.2 + 0.75, 0.06); g.add(f);
    const back = new THREE.Mesh(fg, metal); back.position.set(0, 1.95, 0.05); back.rotation.y = Math.PI; g.add(back);
    this.group.add(g);
  }

  // A board on two posts just beyond the lane's far wall d m along, facing the cars coming; round: a speed limit
  // sign, struck through at its end (end); scale: its size (the PIT IN board is larger).
  private board(d: number, text: string, fg: string, bg: string, round = false, end = false, scale = 1) {
    const L = this.lane;
    const tex = canvasTex(256, 128, (g, w, h) => {
      g.fillStyle = bg; g.fillRect(0, 0, w, h);
      if (round) { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.strokeStyle = '#d8262b'; g.lineWidth = 12; g.beginPath(); g.arc(w / 2, h / 2, 52, 0, Math.PI * 2); g.stroke(); }
      g.fillStyle = fg; g.font = `bold ${round ? 56 : 54}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(text, w / 2, h / 2 + 2);
      if (end) { g.strokeStyle = '#111'; g.lineWidth = 10; g.beginPath(); g.moveTo(w / 2 - 40, h / 2 + 40); g.lineTo(w / 2 + 40, h / 2 - 40); g.stroke(); }
    }, { repeat: false });
    const face = this.mat(new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    const post = this.mat(new THREE.MeshStandardMaterial({ color: 0x2a2e35, roughness: 0.6, metalness: 0.5 }));
    const p = lanePoint(L, d, this.wOut(d) + LANE.outerWall + 0.6), g = new THREE.Group();
    g.position.set(p.x, 0, p.z);
    g.rotation.y = Math.atan2(p.tx, p.tz) + Math.PI;   // the face (+z of the plane) towards the cars
    const pg = new THREE.BoxGeometry(0.08, 1.6 * scale, 0.08), fg2 = new THREE.PlaneGeometry(1.6 * scale, 0.8 * scale);
    this.owned.push(pg, fg2);
    for (const x of [-0.6 * scale, 0.6 * scale]) { const m = new THREE.Mesh(pg, post); m.position.set(x, 0.8 * scale, 0); g.add(m); }
    const f = new THREE.Mesh(fg2, face); f.position.y = 2 * scale; g.add(f);
    const backM = new THREE.Mesh(fg2, post); backM.position.y = 2 * scale; backM.rotation.y = Math.PI; g.add(backM);
    this.group.add(g);
  }
}
