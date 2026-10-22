import { lerp } from './util.js';

// ============================================================================
// Lap timing
// ============================================================================
export class Timing {
  constructor(track, storeKey) {
    this.track = track;
    const N = track.N;
    this.lines = [0, Math.round(N / 3), Math.round((2 * N) / 3)].map((i) => {
      const l = Math.max(track.barL[i], track.WL[i] + 30) + 2, r = Math.max(track.barR[i], track.WR[i] + 30) + 2;
      return { i, s: track.S[i], tx: track.TX[i], tz: track.TZ[i],
        ax: track.X[i] - track.NX[i] * r, az: track.Z[i] - track.NZ[i] * r,
        bx: track.X[i] + track.NX[i] * l, bz: track.Z[i] + track.NZ[i] * l };
    });
    this.useStore(storeKey);
    this.events = [];
    this.reset();
  }
  // Best times are kept per car; switching store also clears this session's laps.
  useStore(key) {
    this.storeKey = key; this.store = loadStore(key);
    this.sessionBestSectors = [null, null, null]; this.sessionBest = null;
    this.laps = []; this.lastLap = null;
  }
  reset() {
    this.lapStart = null; this.next = 0; this.valid = true; this.sectorStart = 0;
    this.cur = [null, null, null]; this.trace = []; this.invalidReason = '';
  }
  invalidate(reason) {
    if (this.lapStart != null && this.valid) { this.valid = false; this.invalidReason = reason; this.events.push({ type: 'invalid', reason }); }
  }
  // Called once per physics tick. t0 = sim time at start of tick.
  tick(prev, curr, t0, dt, car) {
    const rx = curr.x - prev.x, rz = curr.z - prev.z;
    for (let k = 0; k < 3; k++) {
      const ln = this.lines[k];
      const sx = ln.bx - ln.ax, sz = ln.bz - ln.az;
      const den = rx * sz - rz * sx;
      if (Math.abs(den) < 1e-9) continue;
      const qx = ln.ax - prev.x, qz = ln.az - prev.z;
      const t = (qx * sz - qz * sx) / den, u = (qx * rz - qz * rx) / den;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      const tc = t0 + t * dt;
      if (rx * ln.tx + rz * ln.tz < 0) { this.invalidate('WRONG WAY'); if (k === 0) this.next = -1; continue; }
      this.cross(k, tc);
    }
    // track limits
    if (this.lapStart != null && this.valid && car.wheels.every((w) => w.out)) this.invalidate('TRACK LIMITS');
    // delta trace (10 m buckets)
    if (this.lapStart != null) {
      const el = t0 + dt - this.lapStart, d = car.proj.s;
      if (!(d > this.track.L - 60 && el < 6)) {
        const bkt = Math.floor(d / 10);
        if (this.trace[bkt] == null && (bkt === 0 || this.trace[bkt - 1] != null)) this.trace[bkt] = el;
      }
    }
  }
  cross(k, tc) {
    if (k === 0) {
      if (this.lapStart != null && this.next === 0) {
        this.cur[2] = tc - this.sectorStart;
        this.completeLap(tc - this.lapStart);
      }
      this.lapStart = tc; this.sectorStart = tc; this.next = 1; this.valid = true;
      this.cur = [null, null, null]; this.trace = [0]; this.invalidReason = '';
      return;
    }
    if (this.lapStart != null && this.next === k) {
      this.cur[k - 1] = tc - this.sectorStart;
      this.sectorStart = tc;
      this.next = (k + 1) % 3;
      this.events.push({ type: 'sector', k: k - 1, t: this.cur[k - 1] });
    }
  }
  sectorClass(k, t) {
    if (t == null) return '';
    if (!this.valid) return 'yellow';
    const pb = this.store.bestSectors[k];
    if (pb == null || t <= pb + 1e-6) return 'purple';
    const sb = this.sessionBestSectors[k];
    if (sb == null || t <= sb + 1e-6) return 'green';
    return 'yellow';
  }
  completeLap(lapTime) {
    const sectors = this.cur.slice();
    const valid = this.valid;
    const classes = sectors.map((t, k) => this.sectorClass(k, t));
    let pb = false;
    if (valid) {
      sectors.forEach((t, k) => {
        if (this.sessionBestSectors[k] == null || t < this.sessionBestSectors[k]) this.sessionBestSectors[k] = t;
        if (this.store.bestSectors[k] == null || t < this.store.bestSectors[k]) this.store.bestSectors[k] = t;
      });
      if (this.sessionBest == null || lapTime < this.sessionBest) this.sessionBest = lapTime;
      if (this.store.bestLap == null || lapTime < this.store.bestLap) {
        pb = true;
        this.store.bestLap = lapTime; this.store.bestTrace = this.trace.slice(); this.store.bestLapSectors = sectors;
      }
      saveStore(this.storeKey, this.store);
    }
    const prevBest = pb ? null : this.store.bestLap;
    this.lastLap = { time: lapTime, sectors, classes, valid, pb, reason: this.invalidReason };
    this.laps.unshift(this.lastLap);
    this.events.push({ type: 'lap', lap: this.lastLap, deltaToBest: prevBest != null ? lapTime - prevBest : null });
  }
  liveDelta(simTime, s) {
    const bt = this.store.bestTrace;
    if (this.lapStart == null || !bt || !bt.length) return null;
    const el = simTime - this.lapStart;
    if (s > this.track.L - 60 && el < 6) return 0;
    const f = s / 10, b = Math.floor(f);
    if (bt[b] == null || bt[b + 1] == null) return null;
    return el - lerp(bt[b], bt[b + 1], f - b);
  }
}
export function loadStore(key) {
  const empty = { bestLap: null, bestSectors: [null, null, null], bestTrace: null, bestLapSectors: null };
  try { const s = JSON.parse(localStorage.getItem(key)); if (s && Array.isArray(s.bestSectors)) return { ...empty, ...s }; } catch (e) { /* storage unavailable */ }
  return empty;
}
export function saveStore(key, s) { try { localStorage.setItem(key, JSON.stringify(s)); } catch (e) { /* storage unavailable */ } }
