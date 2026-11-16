import { GhostRecorder, GHOST_SUFFIX, loadGhost, saveGhost, unpackGhost, type GhostLap } from './ghost';
import type { Track } from './track';
import { lerp } from './util';
import type { Vehicle } from './vehicle';

// ============================================================================
// Lap timing
// ============================================================================
type SectorTimes = (number | null)[];            // 3 sectors; null = not reached yet

// Saved per car in localStorage.
export interface BestStore {
  bestLap: number | null;
  bestSectors: SectorTimes;                      // best of each sector across all valid laps
  bestTrace: number[] | null;                    // elapsed time at every 10 m of the best lap (for the live delta)
  bestLapSectors: SectorTimes | null;            // sector times of the best lap itself
}

export interface Lap { time: number; sectors: SectorTimes; classes: string[]; valid: boolean; pb: boolean; reason: string }

export type TimingEvent =
  | { type: 'invalid'; reason: string }
  | { type: 'sector'; k: number; t: number }
  | { type: 'lap'; lap: Lap; deltaToBest: number | null };

interface TimingLine { i: number; s: number; tx: number; tz: number; ax: number; az: number; bx: number; bz: number }

export class Timing {
  readonly lines: TimingLine[];                  // start/finish, then the two sector lines
  events: TimingEvent[] = [];                    // drained by the HUD each frame
  storeKey!: string; store!: BestStore;
  sessionBestSectors!: SectorTimes; sessionBest!: number | null;
  laps!: Lap[]; lastLap!: Lap | null;
  // current lap
  lapStart!: number | null; valid!: boolean; invalidReason!: string;
  cur!: SectorTimes; trace!: number[];
  next!: number; sectorStart!: number;           // next line expected (-1 after wrong-way); current sector start
  // The best lap's recording (ghost.ts), replayed by the ghost car; saved next to the best times. Null if there is
  // no best lap, or its recording was lost (storage full) or is from before ghosts were recorded.
  ghost!: GhostLap | null;
  ghostSaved = true;                             // whether the last new best lap's recording fitted in storage
  private readonly rec = new GhostRecorder();    // the lap under way

  constructor(private readonly track: Track, storeKey: string) {
    const N = track.N;
    this.lines = [0, Math.round(N / 3), Math.round((2 * N) / 3)].map((i) => {
      const l = Math.max(track.barL[i], track.WL[i] + 30) + 2, r = Math.max(track.barR[i], track.WR[i] + 30) + 2;
      return { i, s: track.S[i], tx: track.TX[i], tz: track.TZ[i],
        ax: track.X[i] - track.NX[i] * r, az: track.Z[i] - track.NZ[i] * r,
        bx: track.X[i] + track.NX[i] * l, bz: track.Z[i] + track.NZ[i] * l };
    });
    this.useStore(storeKey);
    this.reset();
  }
  // Best times are kept per car; switching store also clears this session's laps.
  useStore(key: string) {
    this.storeKey = key; this.store = loadStore(key);
    this.ghost = loadGhost(key, this.store.bestLap);
    this.sessionBestSectors = [null, null, null]; this.sessionBest = null;
    this.laps = []; this.lastLap = null;
  }
  reset() {
    this.lapStart = null; this.next = 0; this.valid = true; this.sectorStart = 0;
    this.cur = [null, null, null]; this.trace = []; this.invalidReason = '';
    this.rec.stop();
  }
  invalidate(reason: string) {
    if (this.lapStart != null && this.valid) { this.valid = false; this.invalidReason = reason; this.events.push({ type: 'invalid', reason }); }
  }
  // Called once per physics tick. t0 = sim time at start of tick.
  tick(prev: { x: number; z: number }, curr: { x: number; z: number }, t0: number, dt: number, car: Vehicle) {
    const rx = curr.x - prev.x, rz = curr.z - prev.z;
    this.rec.tick(car);
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
      this.cross(k, tc, t0, t0 + dt, car);
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
  // tc: when the line was crossed; tStart, tEnd: sim time at the start and end of this tick
  private cross(k: number, tc: number, tStart: number, tEnd: number, car: Vehicle) {
    if (k === 0) {
      if (this.lapStart != null && this.next === 0) {
        this.cur[2] = tc - this.sectorStart;
        this.rec.finish(car, tEnd - this.lapStart, tc - this.lapStart);
        this.completeLap(tc - this.lapStart);
      }
      this.rec.begin(car, tStart - tc);
      this.lapStart = tc; this.sectorStart = tc; this.next = 1; this.valid = true;
      this.cur = [null, null, null]; this.trace = [0]; this.invalidReason = '';
      return;
    }
    if (this.lapStart != null && this.next === k) {
      this.cur[k - 1] = tc - this.sectorStart;
      this.sectorStart = tc;
      this.next = (k + 1) % 3;
      this.events.push({ type: 'sector', k: k - 1, t: this.cur[k - 1]! });
    }
  }
  sectorClass(k: number, t: number | null) {
    if (t == null) return '';
    if (!this.valid) return 'yellow';
    const pb = this.store.bestSectors[k];
    if (pb == null || t <= pb + 1e-6) return 'purple';
    const sb = this.sessionBestSectors[k];
    if (sb == null || t <= sb + 1e-6) return 'green';
    return 'yellow';
  }
  private completeLap(lapTime: number) {
    const sectors = this.cur.slice();
    const valid = this.valid;
    const classes = sectors.map((t, k) => this.sectorClass(k, t));
    let pb = false;
    if (valid) {
      sectors.forEach((st, k) => {
        const t = st!;   // a valid lap crossed every sector line, so all three are set
        if (this.sessionBestSectors[k] == null || t < this.sessionBestSectors[k]) this.sessionBestSectors[k] = t;
        if (this.store.bestSectors[k] == null || t < this.store.bestSectors[k]) this.store.bestSectors[k] = t;
      });
      if (this.sessionBest == null || lapTime < this.sessionBest) this.sessionBest = lapTime;
      if (this.store.bestLap == null || lapTime < this.store.bestLap) {
        pb = true;
        this.store.bestLap = lapTime; this.store.bestTrace = this.trace.slice(); this.store.bestLapSectors = sectors;
      }
      saveStore(this.storeKey, this.store);   // first: the times must not depend on the recording fitting
      if (pb) {
        const packed = this.rec.pack();
        this.ghost = packed && unpackGhost(packed);   // as it will load next time
        this.ghostSaved = saveGhost(this.storeKey, packed);
      }
    }
    const prevBest = pb ? null : this.store.bestLap;
    this.lastLap = { time: lapTime, sectors, classes, valid, pb, reason: this.invalidReason };
    this.laps.unshift(this.lastLap);
    this.events.push({ type: 'lap', lap: this.lastLap, deltaToBest: prevBest != null ? lapTime - prevBest : null });
  }
  liveDelta(simTime: number, s: number) {
    const bt = this.store.bestTrace;
    if (this.lapStart == null || !bt || !bt.length) return null;
    const el = simTime - this.lapStart;
    if (s > this.track.L - 60 && el < 6) return 0;
    const f = s / 10, b = Math.floor(f);
    if (bt[b] == null || bt[b + 1] == null) return null;
    return el - lerp(bt[b], bt[b + 1], f - b);
  }
}
// Saved best times, or empty ones if there are none or they're unreadable (corrupt, or from an incompatible version).
export function loadStore(key: string): BestStore {
  const empty: BestStore = { bestLap: null, bestSectors: [null, null, null], bestTrace: null, bestLapSectors: null };
  try {
    const s: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    const store = s && typeof s === 'object' ? { ...empty, ...s } : null;   // fields added later default to empty
    if (isBestStore(store)) return store;
  } catch { /* storage unavailable or corrupt */ }
  return empty;
}
const isTime = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isSectors = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((t) => t === null || isTime(t));
function isBestStore(s: object | null): s is BestStore {
  if (!s) return false;
  const b = s as Record<keyof BestStore, unknown>;
  return (b.bestLap === null || isTime(b.bestLap)) && isSectors(b.bestSectors)
    && (b.bestTrace === null || (Array.isArray(b.bestTrace) && b.bestTrace.every((t) => t === null || Number.isFinite(t))))
    && (b.bestLapSectors === null || isSectors(b.bestLapSectors));
}
// Deletes the best times and ghost saved for a key ("Reset best times"); useStore(key) then starts afresh.
export function clearStore(key: string) {
  try { localStorage.removeItem(key); localStorage.removeItem(key + GHOST_SUFFIX); } catch { /* storage unavailable */ }
}
function saveStore(key: string, s: BestStore) { try { localStorage.setItem(key, JSON.stringify(s)); } catch { /* storage unavailable */ } }
