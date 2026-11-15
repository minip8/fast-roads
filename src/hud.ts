import { DT, SURF } from './config';
import { $ } from './dom';
import { Minimap, type Bounds } from './minimap';
import type { Timing } from './timing';
import type { Track } from './track';
import { clamp, fmtDelta, fmtSec, fmtTime } from './util';
import type { Vehicle } from './vehicle';

// ============================================================================
// In-game HUD: lap/sector timing, messages, dash (shift lights, pedals, gear, speed), minimap
// ============================================================================
// The HUD updates every frame, but most of it changes a few times a second: only write what changed, so unchanged
// text, classes and styles don't cost a DOM mutation (and style recalculation) each frame.
// Those parts of the page are only ever written through these, so the caches always match it.
const texts = new WeakMap<Node, string>(), classes = new WeakMap<Element, string>(), styles = new WeakMap<HTMLElement, string>();
function setText(el: Node, text: string) { if (texts.get(el) !== text) { texts.set(el, text); el.textContent = text; } }
function setClass(el: Element, cls: string) { if (classes.get(el) !== cls) { classes.set(el, cls); el.className = cls; } }
function setStyle(el: HTMLElement, prop: 'left' | 'height', value: string) {
  if (styles.get(el) !== value) { styles.set(el, value); el.style[prop] = value; }
}

export interface HudFrame {
  car: Vehicle; timing: Timing;
  simTime: number; alpha: number;   // physics time and interpolation fraction into the next tick
  dt: number; autoOn: boolean; paused: boolean;
  mouseSteer: number | null;        // mouse steering position, or null when mouse steering is off
}

export class Hud {
  readonly root = $('hud');
  private readonly el = { lap: $('lapTime'), state: $('lapState'), delta: $('delta'), last: $('lastLap'), best: $('bestLap'), opt: $('optLap'),
    list: $('lapList'), speed: $('speed'), gear: $('gear'), flags: $('flags'), msg: $('msg'), help: $('help'),
    shiftLights: $('shiftLights'), thr: $('thrFill'), brk: $('brkFill'), mouseKnob: $('mouseSteerKnob'),
    sec: [0, 1, 2].map((k) => $('sec' + k)), secTime: [0, 1, 2].map((k) => $('sec' + k).querySelector('b')!) };
  private readonly lights: HTMLElement[] = [];
  private readonly minimap: Minimap;
  private litCount = -1;
  private msgTimer = 0;
  private helpTimer = 14;

  constructor(track: Track, bounds: Bounds, timing: Timing) {
    $('trkLen').textContent = (track.L / 1000).toFixed(2) + ' km';
    for (let k = 0; k < 15; k++) {
      const d = document.createElement('i'); d.className = k < 5 ? 'g' : k < 10 ? 'r' : 'b';
      this.el.shiftLights.append(d); this.lights.push(d);
    }
    this.minimap = new Minimap($<HTMLCanvasElement>('minimap'), track, bounds, timing);
  }

  get hidden() { return this.root.hidden === true; }
  set hidden(v: boolean) { this.root.hidden = v; }

  showMsg(html: string, secs = 2.5) { this.el.msg.innerHTML = html; this.el.msg.classList.add('show'); this.msgTimer = secs; }
  toggleHelp() { this.el.help.classList.toggle('hidden'); }
  clearLaps() { this.el.list.innerHTML = ''; }

  // Turn this frame's timing events into messages.
  handleEvents(timing: Timing) {
    if (!timing.events.length) return;
    for (const ev of timing.events.splice(0)) {
      if (ev.type === 'invalid') this.showMsg(`<span style="color:var(--red)">${ev.reason}</span><small>Lap time deleted</small>`, 2);
      if (ev.type === 'lap') {
        const l = ev.lap;
        const d = ev.deltaToBest != null ? ` <span style="color:${ev.deltaToBest <= 0 ? 'var(--green)' : 'var(--red)'}">${fmtDelta(ev.deltaToBest)}</span>` : '';
        this.showMsg(l.valid ? `${l.pb ? '<span style="color:var(--purple)">PERSONAL BEST</span><br>' : ''}${fmtTime(l.time)}${l.pb ? '' : d}` : `<span style="color:var(--muted);text-decoration:line-through">${fmtTime(l.time)}</span><small>Invalid lap · ${l.reason}</small>`, 4);
        this.el.list.innerHTML = timing.laps.slice(0, 6).map((l, k) =>
          `<div class="${l.valid ? (l.pb ? 'pb' : '') : 'inv'}"><span>L${timing.laps.length - k}</span><span>${fmtTime(l.time)}</span></div>`).join('');
      }
    }
  }

  update(f: HudFrame) {
    if (this.root.hidden) return;
    const { car, timing, simTime } = f, el = this.el;
    const dt = f.paused ? 0 : f.dt;   // messages and the help panel wait while the game is paused
    const lapStart = timing.lapStart, lapRunning = lapStart != null;
    setText(el.lap, lapRunning ? fmtTime(simTime + f.alpha * DT - lapStart) : '-:--.---');
    el.lap.classList.toggle('invalid', lapRunning && !timing.valid);
    setText(el.state, !lapRunning ? 'OUT LAP' : timing.valid ? `LAP ${timing.laps.length + 1}` : `LAP ${timing.laps.length + 1} · INVALID (${timing.invalidReason})`);
    const dl = timing.valid ? timing.liveDelta(simTime, car.proj.s) : null;
    setText(el.delta, dl != null ? fmtDelta(dl) : '');
    setClass(el.delta, 'num ' + (dl == null ? '' : dl <= 0 ? 'ahead' : 'behind'));
    for (let k = 0; k < 3; k++) {
      const t = timing.cur[k];
      let txt, cls;
      if (lapRunning && t != null) { txt = fmtSec(t); cls = timing.sectorClass(k, t); }
      else if (lapRunning && timing.next === (k + 1) % 3) { txt = fmtSec(simTime - timing.sectorStart); cls = 'live'; }
      else if (!lapRunning && timing.lastLap) { txt = fmtSec(timing.lastLap.sectors[k]); cls = timing.lastLap.classes[k]; }
      else { txt = '—'; cls = ''; }
      setClass(el.sec[k], 'sec ' + cls);
      setText(el.secTime[k], txt);
    }
    setText(el.last, timing.lastLap ? fmtTime(timing.lastLap.time) + (timing.lastLap.valid ? '' : ' ✕') : '—');
    setText(el.best, fmtTime(timing.store.bestLap));
    const [b0, b1, b2] = timing.store.bestSectors;
    setText(el.opt, b0 != null && b1 != null && b2 != null ? fmtTime(b0 + b1 + b2) : '—');
    setText(el.speed, String(Math.round(Math.abs(car.speedF) * 3.6)));
    setText(el.gear, car.gear === 0 ? 'R' : !car.manual && Math.abs(car.speedF) < 0.5 && car.throttle < 0.05 ? 'N' : String(car.gear));
    this.updateDash(car);
    let surf = 0;
    for (const w of car.wheels) surf = Math.max(surf, w.surf);
    const surfName = SURF[surf].name;
    setText(el.flags, `${car.manual ? 'MANUAL' : 'AUTO'} · TC ${car.tc ? 'ON' : 'OFF'}${f.autoOn ? ' · AUTOPILOT' : ''}${f.paused ? ' · PAUSED' : ''}${surfName !== 'asphalt' ? ' · ' + surfName.toUpperCase() : ''}`);
    if (this.msgTimer > 0 && (this.msgTimer -= dt) <= 0) el.msg.classList.remove('show');
    if (f.mouseSteer != null) setStyle(el.mouseKnob, 'left', (50 - f.mouseSteer * 50) + '%');
    if (this.helpTimer > 0 && (this.helpTimer -= dt) <= 0) el.help.classList.add('hidden');
    this.minimap.draw(car);
  }

  // Shift lights fill from the car's shiftLightsFrom to its auto-upshift point, then all flash; pedal bars.
  private updateDash(car: Vehicle) {
    const n = car.gear === 0 ? 0 : Math.round(clamp((car.rpm - car.spec.shiftLightsFrom) / (car.spec.shiftPoint - car.spec.shiftLightsFrom), 0, 1) * 15);
    if (n !== this.litCount) { this.lights.forEach((d, k) => d.classList.toggle('on', k < n)); this.litCount = n; }
    const sl = this.el.shiftLights, flashing = n === 15;
    sl.classList.toggle('flash', flashing);
    sl.classList.toggle('off', flashing && Math.floor(performance.now() / 70) % 2 === 1);
    setStyle(this.el.thr, 'height', Math.round(clamp(car.throttle, 0, 1) * 100) + '%');
    setStyle(this.el.brk, 'height', Math.round(clamp(car.brake, 0, 1) * 100) + '%');
  }
}
