import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { GRAVEL_W, G_GROUND, G_WALL, KERB_W, LIMIT_TOL_NO_KERB, S_ASPHALT, S_GRASS, S_GRAVEL, S_KERB, groups } from './config.js';
import { dilate, lerp, removeShortRuns, smoothClosed, wrapI } from './util.js';

// ============================================================================
// Track: CSV -> smoothed closed spline sampled every ~2 m, with kerbs/gravel/barriers
// ============================================================================
export function parseCSV(text) {
  const pts = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t[0] === '#' || t[0] === '/') continue;
    const [x, y, wr, wl] = t.split(',').map(Number);
    if ([x, y, wr, wl].some((v) => !isFinite(v))) continue;
    pts.push({ x, z: -y, wl, wr });          // data y (north) -> world -z
  }
  return pts;
}

export function buildTrack(raw) {
  const n = raw.length, SUB = 5, dense = [];
  for (let i = 0; i < n; i++) {
    const p0 = raw[wrapI(i - 1, n)], p1 = raw[i], p2 = raw[(i + 1) % n], p3 = raw[(i + 2) % n];
    for (let j = 0; j < SUB; j++) {
      const t = j / SUB, t2 = t * t, t3 = t2 * t;
      const cr = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      dense.push({ x: cr(p0.x, p1.x, p2.x, p3.x), z: cr(p0.z, p1.z, p2.z, p3.z), wl: lerp(p1.wl, p2.wl, t), wr: lerp(p1.wr, p2.wr, t) });
    }
  }
  const m = dense.length, cum = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) {
    const a = dense[i], b = dense[(i + 1) % m];
    cum[i + 1] = cum[i] + Math.hypot(b.x - a.x, b.z - a.z);
  }
  const N = Math.round(cum[m] / 2);
  let X = new Float64Array(N), Z = new Float64Array(N), WL = new Float64Array(N), WR = new Float64Array(N);
  for (let i = 0, j = 0; i < N; i++) {
    const s = (i * cum[m]) / N;
    while (cum[j + 1] < s) j++;
    const f = (s - cum[j]) / (cum[j + 1] - cum[j] || 1);
    const a = dense[j], b = dense[(j + 1) % m];
    X[i] = lerp(a.x, b.x, f); Z[i] = lerp(a.z, b.z, f);
    WL[i] = lerp(a.wl, b.wl, f); WR[i] = lerp(a.wr, b.wr, f);
  }
  X = smoothClosed(X, 1, 3); Z = smoothClosed(Z, 1, 3);
  WL = smoothClosed(WL, 4, 2); WR = smoothClosed(WR, 4, 2);

  const S = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) S[i + 1] = S[i] + Math.hypot(X[(i + 1) % N] - X[i], Z[(i + 1) % N] - Z[i]);
  const L = S[N];

  const TX = new Float64Array(N), TZ = new Float64Array(N), NX = new Float64Array(N), NZ = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = wrapI(i - 1, N), b = (i + 1) % N;
    let tx = X[b] - X[a], tz = Z[b] - Z[a];
    const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    TX[i] = tx; TZ[i] = tz;
    NX[i] = tz; NZ[i] = -tx;                 // left-pointing normal (up x tangent)
  }
  // Signed curvature, positive = turning left
  const K = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = wrapI(i - 1, N), b = (i + 1) % N;
    const ds = S[i + 1] - S[i] + (S[i] - S[a] + (i === 0 ? L : 0));
    K[i] = ((TX[b] - TX[a]) * NX[i] + (TZ[b] - TZ[a]) * NZ[i]) / (ds || 4);
  }
  const KS = smoothClosed(K, 8, 2);

  const track = { N, L, X, Z, S, TX, TZ, NX, NZ, WL, WR, K, KS };

  // --- kerbs & gravel (side +1 = left, -1 = right)
  const mk = (fn) => { const a = new Uint8Array(N); for (let i = 0; i < N; i++) a[i] = fn(i) ? 1 : 0; return a; };
  track.kerbL = removeShortRuns(dilate(mk((i) => KS[i] > 1 / 220 || KS[i] < -1 / 120), 6, 6), 8);
  track.kerbR = removeShortRuns(dilate(mk((i) => -KS[i] > 1 / 220 || -KS[i] < -1 / 120), 6, 6), 8);
  track.gravelL = removeShortRuns(dilate(mk((i) => KS[i] < -1 / 130), 8, 25), 10);
  track.gravelR = removeShortRuns(dilate(mk((i) => -KS[i] < -1 / 130), 8, 25), 10);

  // --- barriers: lateral offset from centerline per side, plus validity mask
  const nearestDist = (x, z) => {
    let bd = Infinity;
    for (let j = 0; j < N; j++) { const dx = x - X[j], dz = z - Z[j]; const d = dx * dx + dz * dz; if (d < bd) bd = d; }
    return Math.sqrt(bd);
  };
  for (const side of [1, -1]) {
    const edge = side > 0 ? WL : WR, gravel = side > 0 ? track.gravelL : track.gravelR;
    let off = new Float64Array(N);
    for (let i = 0; i < N; i++) off[i] = edge[i] + (gravel[i] ? KERB_W + GRAVEL_W + 3 : 7);
    off = smoothClosed(off, 12, 3);
    const valid = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const kin = side * KS[i];
      const floor = edge[i] + KERB_W + 2;
      if (kin > 0) off[i] = Math.max(floor, Math.min(off[i], 0.55 / kin));
      // Shrink until the barrier is not closer to some other part of the track than to its own sample.
      for (let tries = 0; tries < 4; tries++) {
        const bx = X[i] + NX[i] * off[i] * side, bz = Z[i] + NZ[i] * off[i] * side;
        if (nearestDist(bx, bz) >= off[i] - 0.75) { valid[i] = 1; break; }
        off[i] = Math.max(floor, off[i] * 0.6);
      }
    }
    removeShortRuns(valid, 4);
    if (side > 0) { track.barL = off; track.barLValid = valid; } else { track.barR = off; track.barRValid = valid; }
  }
  track.nearestDist = nearestDist;
  return track;
}

// Projection of a world point onto the track. Uses a local search around `hint` (sample index),
// falling back to a global search if the point is far away (teleport/reset).
export function projectOnTrack(tr, x, z, hint, out) {
  const N = tr.N;
  let best = -1, bd = Infinity;
  if (hint >= 0) {
    for (let k = -14; k <= 14; k++) {
      const i = wrapI(hint + k, N), dx = x - tr.X[i], dz = z - tr.Z[i], d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
  }
  if (bd > 900) {
    for (let i = 0; i < N; i++) {
      const dx = x - tr.X[i], dz = z - tr.Z[i], d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
  }
  const dx = x - tr.X[best], dz = z - tr.Z[best];
  out.i = best;
  out.lat = dx * tr.NX[best] + dz * tr.NZ[best];
  const s = tr.S[best] + dx * tr.TX[best] + dz * tr.TZ[best];
  out.s = ((s % tr.L) + tr.L) % tr.L;
  return out;
}

// Track-relative point at arc length s and lateral offset lat.
export function pointAt(tr, s, lat = 0) {
  s = ((s % tr.L) + tr.L) % tr.L;
  let i = Math.min(tr.N - 1, Math.floor((s / tr.L) * tr.N));
  while (i > 0 && tr.S[i] > s) i--;
  while (i < tr.N - 1 && tr.S[i + 1] <= s) i++;
  const j = (i + 1) % tr.N, f = (s - tr.S[i]) / (tr.S[i + 1] - tr.S[i] || 1);
  const nx = lerp(tr.NX[i], tr.NX[j], f), nz = lerp(tr.NZ[i], tr.NZ[j], f);
  return { x: lerp(tr.X[i], tr.X[j], f) + nx * lat, z: lerp(tr.Z[i], tr.Z[j], f) + nz * lat, i };
}

// Surface classification. Returns surface index; writes kerb height into res.h.
export function kerbHeight(e, s) {
  const base = e < 0.35 ? 0.006 + 0.039 * (e / 0.35) : lerp(0.045, 0.03, (e - 0.35) / (KERB_W - 0.35));
  return base + 0.006 * (Math.sin(s * 4.19) > 0 ? 1 : 0);    // rumble strips
}
export function surfaceAt(tr, i, lat, s, res) {
  const wl = tr.WL[i], wr = tr.WR[i];
  res.h = 0;
  if (lat <= wl && lat >= -wr) return (res.surf = S_ASPHALT);
  const left = lat > 0, e = left ? lat - wl : -wr - lat;
  if ((left ? tr.kerbL[i] : tr.kerbR[i]) && e <= KERB_W) { res.h = kerbHeight(e, s); return (res.surf = S_KERB); }
  const bar = left ? tr.barL[i] : tr.barR[i];
  if ((left ? tr.gravelL[i] : tr.gravelR[i]) && e <= KERB_W + GRAVEL_W && lat * (left ? 1 : -1) < bar) return (res.surf = S_GRAVEL);
  return (res.surf = S_GRASS);
}
export function trackLimitOut(tr, i, lat) {
  if (lat > 0) return lat > tr.WL[i] + (tr.kerbL[i] ? KERB_W : LIMIT_TOL_NO_KERB);
  return -lat > tr.WR[i] + (tr.kerbR[i] ? KERB_W : LIMIT_TOL_NO_KERB);
}

// Walls as static cuboid colliders, one per spline segment per side.
export function buildTrackColliders(tr, world) {
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 1, 5000).setTranslation(0, -1, 0)
    .setFriction(0.6).setCollisionGroups(groups(G_GROUND, 0xffff)));
  let count = 0;
  for (const side of [1, -1]) {
    const off = side > 0 ? tr.barL : tr.barR, valid = side > 0 ? tr.barLValid : tr.barRValid;
    for (let i = 0; i < tr.N; i++) {
      const j = (i + 1) % tr.N;
      if (!valid[i] || !valid[j]) continue;
      const ax = tr.X[i] + tr.NX[i] * side * (off[i] + 0.3), az = tr.Z[i] + tr.NZ[i] * side * (off[i] + 0.3);
      const bx = tr.X[j] + tr.NX[j] * side * (off[j] + 0.3), bz = tr.Z[j] + tr.NZ[j] * side * (off[j] + 0.3);
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.01) continue;
      const yaw = Math.atan2(bx - ax, bz - az);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      world.createCollider(RAPIER.ColliderDesc.cuboid(0.3, 0.8, len / 2 + 0.08)
        .setTranslation((ax + bx) / 2, 0.8, (az + bz) / 2).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setFriction(0.25).setRestitution(0.15).setCollisionGroups(groups(G_WALL, 0xffff)));
      count++;
    }
  }
  return count;
}
