import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CarInfo } from './cars';
import { COMPOUND_COLOURS, COMPOUND_IDS } from './conditions';
import { DT } from './config';
import type { Timing } from './timing';
import { clamp } from './util';
import type { Vehicle } from './vehicle';

// ============================================================================
// The cockpit's live instruments, seen from the Driver camera: a screen and a row of shift lights, both drawn on
// one canvas per car that textures one unlit mesh (one draw call). Three styles: the F1's steering-wheel display
// with shift LEDs across the top, the GT3's dash display with its LED bar above it, and the drift car's cluster
// (tachometer, gear, speed) with a shift light on its hood.
// The meshes are built with the car body (carMeshes.ts, also in Node); the canvas only in the browser, the first
// time the display is shown. It is redrawn only while the Driver camera is on, only when a shown value changes,
// and at most REDRAW_HZ times a second.
// ============================================================================
export type SpeedUnit = 'kmh' | 'mph';
export type ScreenStyle = 'f1' | 'gt3' | 'cluster';

const REDRAW_HZ = 30;
const AID_HOLD = 0.3;   // s a TC / ABS light stays lit after the aid last cut in (it works in pulses)
const SPEED_PER_MS: Record<SpeedUnit, number> = { kmh: 3.6, mph: 2.236936 };
const UNIT_LABEL: Record<SpeedUnit, string> = { kmh: 'KM/H', mph: 'MPH' };

// Canvas layout (px): the LED strip is the top `ledH` rows, the screen the w x h below it.
interface Layout { w: number; h: number; ledH: number; leds: number }
export const LAYOUTS: Record<ScreenStyle, Layout> = {
  f1: { w: 512, h: 256, ledH: 40, leds: 15 },
  gt3: { w: 512, h: 384, ledH: 40, leds: 10 },
  cluster: { w: 512, h: 200, ledH: 40, leds: 7 },
};

// ---------------------------------------------------------------------------------------------------------------
// Meshes
// ---------------------------------------------------------------------------------------------------------------
// A flat rectangle in its parent's frame: centre, size (m), facing -z (the driver), its top leaning `tilt` rad
// away (towards +z).
export interface Quad { x: number; y: number; z: number; w: number; h: number; tilt?: number }

export interface CockpitScreen {
  readonly style: ScreenStyle;
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
}

// The screen and the LED strip as one mesh, mapped onto their parts of the canvas; without a strip the screen
// shows the whole canvas, its LEDs along the top. Until a canvas is attached it is a dark, unlit panel.
export function buildScreen(style: ScreenStyle, screen: Quad, strip: Quad | null): CockpitScreen {
  const L = LAYOUTS[style], H = L.ledH + L.h;
  const quad = (q: Quad, top: number, rows: number) => {
    const g = new THREE.PlaneGeometry(q.w, q.h), uv = g.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setY(k, 1 - (top + (1 - uv.getY(k)) * rows) / H);
    return g.rotateY(Math.PI).rotateX(q.tilt ?? 0).translate(q.x, q.y, q.z);
  };
  const parts = [strip ? quad(screen, L.ledH, L.h) : quad(screen, 0, H)];
  if (strip) parts.push(quad(strip, 0, L.ledH));
  const geo = parts.length > 1 ? mergeGeometries(parts) : parts[0];
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x07080a, toneMapped: false, fog: false }));
  mesh.name = 'display';
  return { style, mesh };
}

// ---------------------------------------------------------------------------------------------------------------
// What the instruments show, as numbers: compared field by field to decide whether to redraw.
// ---------------------------------------------------------------------------------------------------------------
export interface DashValues {
  gear: number;        // -1 R, 0 N, 1.. as the HUD shows it
  speed: number;       // in the display's unit, whole
  rpm: number;         // to 50 rpm
  lights: number;      // shift lights lit, 0..leds
  flash: number;       // 1 while they blink off at the shift point
  lap: number;         // running lap time in tenths, -1 on the out lap
  lapNo: number; valid: number;
  delta: number;       // live delta to the best lap in hundredths, NONE without one
  last: number; best: number;   // ms, -1 without one
  battery: number;     // % charge, -1 without a battery
  flaps: number;       // -1 none, 0 shut, 1 open
  tc: number; abs: number;      // 0 off, 1 on, 2 cutting in (ABS is always on)
  throttle: number; brake: number;   // 0..10
  tyre: number;        // % tread left on the most worn tyre, -1 while the tyres do not wear
  compound: number;    // the fitted compound (index in COMPOUND_IDS) while they wear, else -1
}
export const NONE = 1e9;
const KEYS: (keyof DashValues)[] = ['gear', 'speed', 'rpm', 'lights', 'flash', 'lap', 'lapNo', 'valid', 'delta', 'last', 'best',
  'battery', 'flaps', 'tc', 'abs', 'throttle', 'brake', 'tyre', 'compound'];
export const blankValues = (): DashValues => ({ gear: -9, speed: -1, rpm: -1, lights: -1, flash: -1, lap: -2, lapNo: -1, valid: -1, delta: -1,
  last: -2, best: -2, battery: -2, flaps: -2, tc: -1, abs: -1, throttle: -1, brake: -1, tyre: -2, compound: -2 });

// Shift lights lit out of n: they fill from the car's shiftLightsFrom to its upshift point (as the HUD's).
export function shiftLights(spec: CarInfo, gear: number, rpm: number, n: number) {
  return gear < 0 ? 0 : Math.round(clamp((rpm - spec.shiftLightsFrom) / (spec.shiftPoint - spec.shiftLightsFrom), 0, 1) * n);
}

// The car and timing state the display shows, into `out`. now: wall-clock seconds (the lights' blink).
export function dashValues(car: Vehicle, timing: Timing, simTime: number, alpha: number, unit: SpeedUnit, leds: number, now: number, out: DashValues) {
  out.gear = car.gear < 0 ? -1 : car.gear === 0 || (!car.manual && Math.abs(car.speedF) < 0.5 && car.throttle < 0.05) ? 0 : car.gear;
  out.speed = Math.round(Math.abs(car.speedF) * SPEED_PER_MS[unit]);
  out.rpm = Math.round(car.rpm / 50) * 50;
  out.lights = shiftLights(car.spec, car.gear, car.rpm, leds);
  out.flash = out.lights === leds && Math.floor(now / 0.07) % 2 === 1 ? 1 : 0;
  const start = timing.lapStart;
  out.lap = start == null ? -1 : Math.max(0, Math.floor((simTime + alpha * DT - start) * 10));
  out.lapNo = timing.laps.length + 1;
  out.valid = timing.valid ? 1 : 0;
  const d = timing.valid ? timing.liveDelta(simTime, car.proj.s) : null;
  out.delta = d == null ? NONE : Math.round(d * 100);
  out.last = timing.lastLap ? Math.round(timing.lastLap.time * 1000) : -1;
  out.best = timing.store.bestLap != null ? Math.round(timing.store.bestLap * 1000) : -1;
  out.battery = car.battery == null ? -1 : Math.round(clamp(car.battery, 0, 1) * 100);
  out.flaps = car.flapsOpen == null ? -1 : car.flapsOpen ? 1 : 0;
  out.tc = !car.tc ? 0 : car.tcActive ? 2 : 1;
  out.abs = car.absActive ? 2 : 1;
  out.throttle = Math.round(clamp(car.throttle, 0, 1) * 10);
  out.brake = Math.round(clamp(car.brake, 0, 1) * 10);
  out.tyre = car.wearing ? Math.round((1 - Math.max(...car.tyreWear)) * 100) : -1;
  out.compound = car.wearing ? COMPOUND_IDS.indexOf(car.compound.id) : -1;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Drawing (browser only)
// ---------------------------------------------------------------------------------------------------------------
interface Painter { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture; shown: DashValues; drawnAt: number }
const painters = new WeakMap<CockpitScreen, Painter | null>();

function painter(screen: CockpitScreen): Painter | null {
  let p = painters.get(screen);
  if (p !== undefined) return p;
  p = null;
  if (typeof document !== 'undefined') {
    const L = LAYOUTS[screen.style], canvas = document.createElement('canvas');
    canvas.width = L.w; canvas.height = L.ledH + L.h;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      tex.userData.owned = true;   // carMeshes' dispose frees it with the material
      const m = screen.mesh.material;
      m.map = tex; m.color.set(0xffffff); m.needsUpdate = true;
      p = { ctx, tex, shown: blankValues(), drawnAt: -Infinity };
    }
  }
  painters.set(screen, p);
  return p;
}

// Updates the current car's instruments; main.ts calls it every frame.
export class CockpitDisplay {
  unit: SpeedUnit = 'kmh';   // the display's speed unit: set it from the speed-unit setting when there is one
  private readonly cur = blankValues();
  private tcUntil = 0; private absUntil = 0;

  // visible: the Driver camera is on (no other camera sees the displays, so they are not drawn otherwise)
  update(car: Vehicle, timing: Timing, simTime: number, alpha: number, visible: boolean) {
    const screen = car.mesh.cockpit.screen;   // read at use: a model swapped in brings its own
    if (!visible || !screen) return;
    const p = painter(screen);
    if (!p) return;
    const now = performance.now() / 1000, v = this.cur;
    dashValues(car, timing, simTime, alpha, this.unit, LAYOUTS[screen.style].leds, now, v);
    if (v.tc === 2) this.tcUntil = now + AID_HOLD; else if (v.tc === 1 && now < this.tcUntil) v.tc = 2;
    if (v.abs === 2) this.absUntil = now + AID_HOLD; else if (now < this.absUntil) v.abs = 2;
    let same = true;
    for (const k of KEYS) if (p.shown[k] !== v[k]) { same = false; break; }
    if (same || now - p.drawnAt < 1 / REDRAW_HZ) return;
    for (const k of KEYS) p.shown[k] = v[k];
    p.drawnAt = now;
    drawDisplay(p.ctx, screen.style, v, car.spec, this.unit);
    p.tex.needsUpdate = true;
  }
}

const FONT = 'Arial, Helvetica, sans-serif';
const C = { bg: '#000', frame: '#3a4048', label: '#9aa4b0', text: '#f4f6f8', green: '#2ee05a', red: '#ff2d2d', blue: '#3d8bff',
  amber: '#ffb000', purple: '#c86bff', off: '#1a1d22', dim: '#5d6670' };

const gearText = (g: number) => (g < 0 ? 'R' : g === 0 ? 'N' : String(g));
const lapText = (tenths: number) => {
  if (tenths < 0) return '-:--.-';
  const m = Math.floor(tenths / 600), s = (tenths % 600) / 10;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};
const msText = (ms: number) => {
  if (ms < 0) return '-:--.---';
  const m = Math.floor(ms / 60000), s = (ms % 60000) / 1000;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
};
const deltaText = (cs: number) => (cs === NONE ? '-.--' : (cs > 0 ? '+' : cs < 0 ? '−' : '') + (Math.abs(cs) / 100).toFixed(2));
const deltaColour = (cs: number) => (cs === NONE ? C.dim : cs <= 0 ? C.green : C.red);

export function drawDisplay(ctx: CanvasRenderingContext2D, style: ScreenStyle, v: DashValues, spec: CarInfo, unit: SpeedUnit) {
  const L = LAYOUTS[style];
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, L.w, L.ledH + L.h);
  drawLeds(ctx, style, v, L);
  ctx.save();
  ctx.translate(0, L.ledH);
  if (style === 'f1') drawF1(ctx, v, L, unit);
  else if (style === 'gt3') drawGt3(ctx, v, L, spec, unit);
  else drawCluster(ctx, v, L, spec, unit);
  ctx.restore();
}

function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, colour: string, align: CanvasTextAlign = 'center', weight = 700) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.fillStyle = colour; ctx.textAlign = align; ctx.textBaseline = 'middle';
  ctx.fillText(s, x, y);
}
function box(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, stroke = C.frame, fill?: string) {
  if (fill) { ctx.fillStyle = fill; ctx.fillRect(x, y, w, h); }
  ctx.strokeStyle = stroke; ctx.lineWidth = 3; ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
}
// A lamp: a filled box with its label, lit or dark.
function lamp(ctx: CanvasRenderingContext2D, label: string, x: number, y: number, w: number, h: number, on: boolean, colour: string, size: number) {
  box(ctx, x, y, w, h, on ? colour : C.frame, on ? colour : C.off);
  text(ctx, label, x + w / 2, y + h / 2 + 2, size, on ? '#000' : C.dim);
}

// The tyres while they wear: the compound's letter on its colour, and the tread left on the most worn one (amber
// from half, red from a fifth, as the HUD's tiles).
function tyreBox(ctx: CanvasRenderingContext2D, v: DashValues, x: number, y: number, w: number, h: number, size: number) {
  const id = COMPOUND_IDS[v.compound], letter = id === 'allweather' ? 'A' : id ? id[0].toUpperCase() : '?';
  box(ctx, x, y, w, h);
  ctx.fillStyle = id ? COMPOUND_COLOURS[id] : C.dim;
  ctx.beginPath(); ctx.arc(x + h / 2 + 2, y + h / 2, h / 2 - 6, 0, Math.PI * 2); ctx.fill();
  text(ctx, letter, x + h / 2 + 2, y + h / 2 + 1, size * 0.85, '#000');
  text(ctx, v.tyre + '%', x + w - 8, y + h / 2 + 2, size, v.tyre > 50 ? C.text : v.tyre > 20 ? C.amber : C.red, 'right');
}

// LED colours by style: the F1's 5 green, 5 red, 5 blue (as the HUD's); the GT3's green, amber, red; the drift car's
// shift light green to red.
function ledColour(style: ScreenStyle, k: number, n: number) {
  const f = k / n;
  if (style === 'f1') return f < 1 / 3 ? C.green : f < 2 / 3 ? C.red : C.blue;
  return f < 0.4 ? C.green : f < 0.7 ? C.amber : C.red;
}
function drawLeds(ctx: CanvasRenderingContext2D, style: ScreenStyle, v: DashValues, L: Layout) {
  const n = L.leds, pitch = L.w / n, r = Math.min(pitch * 0.36, L.ledH * 0.4);
  for (let k = 0; k < n; k++) {
    const on = k < v.lights && !v.flash;
    ctx.fillStyle = on ? ledColour(style, k, n) : C.off;
    ctx.beginPath(); ctx.arc(pitch * (k + 0.5), L.ledH / 2, r, 0, Math.PI * 2); ctx.fill();
  }
}

// F1 wheel: big gear in the middle; speed and the live delta on the left; battery and the straight-mode flaps on the right.
function drawF1(ctx: CanvasRenderingContext2D, v: DashValues, L: Layout, unit: SpeedUnit) {
  const { w, h } = L, side = 165;
  box(ctx, side, 0, w - 2 * side, h);
  text(ctx, gearText(v.gear), w / 2, h / 2 + 12, 230, v.lights === L.leds ? C.blue : C.text);
  // left: speed, delta
  text(ctx, String(v.speed), side - 12, 62, 84, C.text, 'right');
  text(ctx, UNIT_LABEL[unit], side - 12, 118, 26, C.label, 'right');
  box(ctx, 0, 148, side - 4, h - 148, deltaColour(v.delta));
  text(ctx, deltaText(v.delta), (side - 4) / 2, 204, 54, deltaColour(v.delta));
  text(ctx, 'DELTA', (side - 4) / 2, 166, 20, C.label);
  // right: battery charge with a bar, flaps
  const x0 = w - side + 4, bw = side - 4;
  text(ctx, 'BATT', x0 + 4, 20, 22, C.label, 'left');
  text(ctx, v.battery < 0 ? '--' : String(v.battery), x0 + bw - 32, 62, 72, C.text, 'right');
  text(ctx, '%', x0 + bw - 4, 72, 28, C.label, 'right');
  box(ctx, x0, 98, bw, 30);
  if (v.battery > 0) {
    ctx.fillStyle = v.battery < 20 ? C.amber : C.green;
    ctx.fillRect(x0 + 5, 103, (bw - 10) * v.battery / 100, 20);
  }
  // the flaps' lamp, sharing its row with the tyres while they wear
  const tw = v.tyre >= 0 ? Math.round(bw * 0.55) : 0;
  if (v.flaps >= 0) lamp(ctx, 'SM', x0, 148, bw - tw - (tw ? 4 : 0), 54, v.flaps === 1, C.green, tw ? 30 : 40);
  if (tw) tyreBox(ctx, v, x0 + bw - tw, 148, tw, 54, 26);
  lamp(ctx, v.tc ? 'TC' : 'TC OFF', x0, 208, bw, 48, v.tc === 2, C.amber, v.tc ? 34 : 26);
}

// GT3 dash: rpm bar across the top, gear in the middle, lap time and delta on the left, speed and the aids on the right.
function drawGt3(ctx: CanvasRenderingContext2D, v: DashValues, L: Layout, spec: CarInfo, unit: SpeedUnit) {
  const { w, h } = L;
  // rpm bar
  const f = clamp(v.rpm / spec.redline, 0, 1), from = spec.shiftLightsFrom / spec.redline;
  box(ctx, 0, 0, w, 52);
  ctx.fillStyle = C.off; ctx.fillRect(6, 6, w - 12, 40);
  ctx.fillStyle = f >= spec.shiftPoint / spec.redline ? C.red : f >= from ? C.amber : C.text;
  ctx.fillRect(6, 6, (w - 12) * f, 40);
  text(ctx, String(v.rpm), w / 2, 27, 34, f > 0.55 ? '#000' : C.text);
  // gear
  const gx = 170, gw = w - 340;
  box(ctx, gx, 60, gw, 230);
  text(ctx, gearText(v.gear), w / 2, 184, 210, v.lights === L.leds ? C.red : C.text);
  // left: lap time and delta
  text(ctx, 'LAP', 6, 76, 22, C.label, 'left');
  text(ctx, lapText(v.lap), gx - 6, 118, 58, v.valid || v.lap < 0 ? C.text : C.red, 'right');
  text(ctx, 'DELTA', 6, 170, 22, C.label, 'left');
  text(ctx, deltaText(v.delta), gx - 6, 214, 66, deltaColour(v.delta), 'right');
  if (v.tyre >= 0) tyreBox(ctx, v, 6, 248, gx - 14, 44, 26);   // in the last lap's place while the tyres wear
  else text(ctx, 'LAST ' + msText(v.last), 6, 268, 24, C.label, 'left');
  // right: speed, aids
  text(ctx, String(v.speed), w - 6, 128, 96, C.text, 'right');
  text(ctx, UNIT_LABEL[unit], w - 6, 186, 24, C.label, 'right');
  lamp(ctx, 'ABS', gx + gw + 8, 216, (w - gx - gw - 16) / 2 - 2, 74, v.abs === 2, C.amber, 30);
  lamp(ctx, v.tc ? 'TC' : 'OFF', gx + gw + 8 + (w - gx - gw - 16) / 2 + 2, 216, (w - gx - gw - 16) / 2 - 2, 74, v.tc === 2, C.blue, 30);
  // bottom: pedals
  const py = 304, ph = h - py - 4;
  box(ctx, 0, py, w, ph + 4);
  text(ctx, 'THR', 10, py + ph / 4 + 4, 22, C.label, 'left');
  text(ctx, 'BRK', 10, py + (3 * ph) / 4, 22, C.label, 'left');
  ctx.fillStyle = C.green; ctx.fillRect(70, py + 10, (w - 84) * v.throttle / 10, ph / 2 - 12);
  ctx.fillStyle = C.red; ctx.fillRect(70, py + ph / 2 + 4, (w - 84) * v.brake / 10, ph / 2 - 12);
}

// Drift car cluster: a tachometer on the left, gear in the middle, speed on the right, lap time and lamps below.
function drawCluster(ctx: CanvasRenderingContext2D, v: DashValues, L: Layout, spec: CarInfo, unit: SpeedUnit) {
  const w = L.w;
  // tachometer: 0..redline+500 over 240 deg, red from the redline, a needle and the thousands
  const cx = 104, cy = 108, r = 94, top = Math.ceil((spec.redline + 500) / 1000) * 1000;
  const ang = (rpm: number) => Math.PI * (0.75 + 1.5 * clamp(rpm / top, 0, 1));
  ctx.lineWidth = 12;
  ctx.strokeStyle = C.off; ctx.beginPath(); ctx.arc(cx, cy, r - 8, ang(0), ang(top)); ctx.stroke();
  ctx.strokeStyle = C.red; ctx.beginPath(); ctx.arc(cx, cy, r - 8, ang(spec.redline), ang(top)); ctx.stroke();
  ctx.strokeStyle = C.amber; ctx.beginPath(); ctx.arc(cx, cy, r - 8, ang(0), ang(Math.min(v.rpm, spec.redline))); ctx.stroke();
  for (let k = 0; k <= top / 1000; k++) {
    const a = ang(k * 1000);
    text(ctx, String(k), cx + Math.cos(a) * (r - 34), cy + Math.sin(a) * (r - 34), 22, k * 1000 >= spec.redline ? C.red : C.label);
  }
  const a = ang(v.rpm);
  ctx.strokeStyle = C.red; ctx.lineWidth = 6; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(cx - Math.cos(a) * 12, cy - Math.sin(a) * 12); ctx.lineTo(cx + Math.cos(a) * (r - 6), cy + Math.sin(a) * (r - 6)); ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.fillStyle = C.frame; ctx.beginPath(); ctx.arc(cx, cy, 12, 0, Math.PI * 2); ctx.fill();
  text(ctx, 'x1000', cx, cy + 48, 18, C.label);
  if (v.tyre >= 0) tyreBox(ctx, v, cx - 50, cy + 66, 100, 26, 20);
  // gear and speed
  box(ctx, 212, 4, 116, 150);
  text(ctx, gearText(v.gear), 270, 86, 150, v.lights === L.leds ? C.red : C.text);
  text(ctx, String(v.speed), w - 8, 86, 96, C.text, 'right');
  text(ctx, UNIT_LABEL[unit], w - 8, 138, 24, C.label, 'right');
  // lap time and lamps
  text(ctx, lapText(v.lap), 270, 180, 34, v.valid || v.lap < 0 ? C.text : C.red);
  lamp(ctx, v.tc ? 'TC' : 'TC OFF', 344, 152, 80, 44, v.tc === 2, C.amber, v.tc ? 28 : 20);
  lamp(ctx, 'ABS', 428, 152, 80, 44, v.abs === 2, C.amber, 28);
}
