import type { Timing } from './timing';
import type { Track } from './track';
import type { Vehicle } from './vehicle';

// ============================================================================
// Minimap: the circuit and timing lines drawn once, the car arrow on top each frame
// ============================================================================
export interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number }
export interface MapDot { x: number; z: number; color: string; ghost: boolean }   // another player's car

export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly base: HTMLCanvasElement;
  private readonly scale: number;
  private readonly offX: number;
  private readonly offZ: number;

  constructor(private readonly canvas: HTMLCanvasElement, track: Track, private readonly bounds: Bounds, timing: Timing) {
    this.ctx = canvas.getContext('2d')!;
    const pad = 30, span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
    this.scale = (canvas.width - pad * 2) / span;
    this.offX = pad + ((span - (bounds.maxX - bounds.minX)) * this.scale) / 2;
    this.offZ = pad + ((span - (bounds.maxZ - bounds.minZ)) * this.scale) / 2;

    this.base = document.createElement('canvas'); this.base.width = canvas.width; this.base.height = canvas.height;
    const g = this.base.getContext('2d')!;
    g.lineJoin = 'round'; g.lineCap = 'round';
    const path = () => {
      g.beginPath();
      for (let i = 0; i <= track.N; i++) { const k = i % track.N; i ? g.lineTo(this.x(track.X[k]), this.y(track.Z[k])) : g.moveTo(this.x(track.X[k]), this.y(track.Z[k])); }
    };
    path(); g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 12; g.stroke();
    path(); g.strokeStyle = '#e8ecf0'; g.lineWidth = 6; g.stroke();
    timing.lines.forEach((ln, k) => {
      g.beginPath(); g.moveTo(this.x(track.X[ln.i] - track.NX[ln.i] * 40), this.y(track.Z[ln.i] - track.NZ[ln.i] * 40));
      g.lineTo(this.x(track.X[ln.i] + track.NX[ln.i] * 40), this.y(track.Z[ln.i] + track.NZ[ln.i] * 40));
      g.strokeStyle = k === 0 ? '#ff4d4d' : '#ffd23f'; g.lineWidth = 4; g.stroke();
    });
  }

  private x(x: number) { return this.offX + (x - this.bounds.minX) * this.scale; }
  private y(z: number) { return this.offZ + (z - this.bounds.minZ) * this.scale; }

  // ghost: where the ghost car is (null: not shown); others: other players' cars
  draw(car: Vehicle, ghost: { x: number; z: number } | null = null, others: readonly MapDot[] = []) {
    const c = this.ctx;
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    c.drawImage(this.base, 0, 0);
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
