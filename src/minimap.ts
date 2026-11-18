import { lanePoint, sampleAt, type PitLane } from './pitLane';
import type { Timing } from './timing';
import type { Track } from './track';
import type { Vehicle } from './vehicle';

// ============================================================================
// Minimap: the circuit, its pit lane and the timing lines drawn once, the car arrow on top each frame. The pit lane
// is its real shape (a thin grey line), pushed out to at least PIT_OFFSET px from the track's line where it runs
// closer than that (a real lane a few metres off the track is under a pixel), less so towards its ends, which meet the
// track. In a room (setPitLane) it is blue with the box as a yellow square; brighter, the box ringed, while the pit
// request is on.
// ============================================================================
const PIT_OFFSET = 12;                // px between the track's line and the pit lane's
export interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number }
export interface MapDot { x: number; z: number; color: string; ghost: boolean }   // another player's car

export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly base: HTMLCanvasElement;
  private readonly scale: number;
  private readonly offX: number;
  private readonly offZ: number;
  private pit: { pts: [number, number][]; box: [number, number] } | null = null;
  private lanePts: [number, number][] = [];   // the lane as drawn (every mode)

  constructor(private readonly canvas: HTMLCanvasElement, track: Track, private readonly bounds: Bounds, timing: Timing) {
    this.ctx = canvas.getContext('2d')!;
    const pad = 30, span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
    this.scale = (canvas.width - pad * 2) / span;
    this.offX = pad + ((span - (bounds.maxX - bounds.minX)) * this.scale) / 2;
    this.offZ = pad + ((span - (bounds.maxZ - bounds.minZ)) * this.scale) / 2;

    this.base = document.createElement('canvas'); this.base.width = canvas.width; this.base.height = canvas.height;
    if (track.pit) { const l = track.pit; for (let k = 0; k < l.n; k += 2) this.lanePts.push(this.lanePx(track, l, l.D[k])); this.lanePts.push(this.lanePx(track, l, l.len)); }
    this.drawBase(track, timing);
  }

  // The lane d m along it on the map: its real place, pushed out from the track's line to PIT_OFFSET px where nearer
  // (fading to none over the first and last 40 m, where it meets the track).
  private lanePx(track: Track, l: PitLane, d: number, off = 0): [number, number] {
    const p = lanePoint(l, d, off), i = l.I[sampleAt(l, d)];
    const sep = l.side * ((p.x - track.X[i]) * track.NX[i] + (p.z - track.Z[i]) * track.NZ[i]);
    const f = Math.min(1, d / 40, (l.len - d) / 40), o = Math.max(0, PIT_OFFSET / this.scale - sep) * f * l.side;
    return [this.x(p.x + track.NX[i] * o), this.y(p.z + track.NZ[i] * o)];
  }

  // The pit lane in a room (null: not in one): blue, with the box.
  setPitLane(track: Track, lane: PitLane | null, timing: Timing) {
    this.pit = lane ? { pts: this.lanePts, box: this.lanePx(track, lane, lane.box, lane.boxOff) } : null;
    this.drawBase(track, timing);
  }

  private drawBase(track: Track, timing: Timing) {
    const g = this.base.getContext('2d')!;
    g.clearRect(0, 0, this.base.width, this.base.height);
    g.lineJoin = 'round'; g.lineCap = 'round';
    const path = () => {
      g.beginPath();
      for (let i = 0; i <= track.N; i++) { const k = i % track.N; i ? g.lineTo(this.x(track.X[k]), this.y(track.Z[k])) : g.moveTo(this.x(track.X[k]), this.y(track.Z[k])); }
    };
    if (!this.pit && this.lanePts.length) {
      g.beginPath(); this.lanePts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = 5; g.stroke();
      g.strokeStyle = '#9aa3ad'; g.lineWidth = 2; g.stroke();
    }
    path(); g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 12; g.stroke();
    path(); g.strokeStyle = '#e8ecf0'; g.lineWidth = 6; g.stroke();
    timing.lines.forEach((ln, k) => {
      g.beginPath(); g.moveTo(this.x(track.X[ln.i] - track.NX[ln.i] * 40), this.y(track.Z[ln.i] - track.NZ[ln.i] * 40));
      g.lineTo(this.x(track.X[ln.i] + track.NX[ln.i] * 40), this.y(track.Z[ln.i] + track.NZ[ln.i] * 40));
      g.strokeStyle = k === 0 ? '#ff4d4d' : '#ffd23f'; g.lineWidth = 4; g.stroke();
    });
    if (this.pit) {
      g.beginPath(); this.pit.pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 7; g.stroke();
      g.strokeStyle = '#3d8bff'; g.lineWidth = 3.5; g.stroke();
      const [bx, by] = this.pit.box;
      g.fillStyle = '#ffd23f'; g.strokeStyle = '#111'; g.lineWidth = 2; g.fillRect(bx - 5, by - 5, 10, 10); g.strokeRect(bx - 5, by - 5, 10, 10);
    }
  }

  private x(x: number) { return this.offX + (x - this.bounds.minX) * this.scale; }
  private y(z: number) { return this.offZ + (z - this.bounds.minZ) * this.scale; }

  // ghost: where the ghost car is (null: not shown); others: other players' cars
  // pitRequest: the pit request is on (the lane and the box stand out)
  draw(car: Vehicle, ghost: { x: number; z: number } | null = null, others: readonly MapDot[] = [], pitRequest = false) {
    const c = this.ctx;
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    c.drawImage(this.base, 0, 0);
    if (pitRequest && this.pit) {
      c.beginPath(); this.pit.pts.forEach(([x, y], k) => (k ? c.lineTo(x, y) : c.moveTo(x, y)));
      c.strokeStyle = '#8fc0ff'; c.lineWidth = 5; c.stroke();
      const [bx, by] = this.pit.box, r = 10 + 3 * Math.sin(performance.now() / 150);
      c.beginPath(); c.arc(bx, by, r, 0, Math.PI * 2); c.strokeStyle = '#ffd23f'; c.lineWidth = 3; c.stroke();
      c.fillStyle = '#ffd23f'; c.strokeStyle = '#111'; c.lineWidth = 2; c.fillRect(bx - 6, by - 6, 12, 12); c.strokeRect(bx - 6, by - 6, 12, 12);
    }
    if (ghost) {
      c.beginPath(); c.arc(this.x(ghost.x), this.y(ghost.z), 7, 0, Math.PI * 2);
      c.fillStyle = 'rgba(159,216,255,.75)'; c.strokeStyle = 'rgba(0,0,0,.6)'; c.lineWidth = 2; c.stroke(); c.fill();
    }
    for (const o of others) {
      c.globalAlpha = o.ghost ? 0.55 : 1;
      c.beginPath(); c.arc(this.x(o.x), this.y(o.z), 8, 0, Math.PI * 2);
      c.fillStyle = o.color; c.strokeStyle = '#111'; c.lineWidth = 3; c.stroke(); c.fill();
    }
    c.globalAlpha = 1;
    const hx = car.fwd.x, hz = car.fwd.z, px = this.x(car.pos.x), py = this.y(car.pos.z);
    c.beginPath(); c.moveTo(px + hx * 14, py + hz * 14); c.lineTo(px - hz * 8 - hx * 8, py + hx * 8 - hz * 8); c.lineTo(px + hz * 8 - hx * 8, py - hx * 8 - hz * 8); c.closePath();
    c.fillStyle = '#ff6a13'; c.strokeStyle = '#111'; c.lineWidth = 3; c.stroke(); c.fill();
  }
}
