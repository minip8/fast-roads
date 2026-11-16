import type { DriveInput } from './car';
import { DEFAULT_BINDINGS, copyBindings, type Action, type Bindings } from './keys';
import { clamp } from './util';

// ============================================================================
// Input
// ============================================================================
// Mouse steering: how far the cursor goes from the screen centre (fraction of half the width) for full lock.
// The response is linear: the wheel is proportional to the cursor's distance past the dead zone.
export const MOUSE_RANGE = { low: 0.95, medium: 0.7, high: 0.5 };
// Dead zone: fraction of half the width around the centre that does nothing.
export const MOUSE_DEADZONE = { off: 0, small: 0.03, medium: 0.08, large: 0.15 };

// Gamepad steering: stick dead zone (share of travel, the Gamepad deadzone setting) and response curve
// (>1 = gentle near the centre).
export const PAD_DEADZONE = { small: 0.04, medium: 0.08, large: 0.15 };
const PAD_CURVE = 1.4;

// Gamepad buttons (standard mapping) that act like a key press: Y camera, X and Back restart, Start menu, RB/LB shift.
export const PAD_BUTTONS: readonly [button: number, action: Action][] = [[3, 'camera'], [2, 'restart'], [8, 'restart'], [9, 'menu'], [5, 'shiftUp'], [4, 'shiftDown']];
// Gamepad buttons in the menu, as the keys they stand for: d-pad, A select, B / Start back, LB / RB change tab.
const PAD_MENU: readonly [button: number, code: string][] = [[12, 'ArrowUp'], [13, 'ArrowDown'], [14, 'ArrowLeft'], [15, 'ArrowRight'],
  [0, 'Enter'], [1, 'Escape'], [9, 'Escape'], [4, 'TabPrev'], [5, 'TabNext']];

export type MouseSensitivity = keyof typeof MOUSE_RANGE;
export type MouseDeadzone = keyof typeof MOUSE_DEADZONE;
export type PadDeadzone = keyof typeof PAD_DEADZONE;

export class Input {
  readonly keys = new Set<string>();             // KeyboardEvent.code values held now
  // codes pressed since last cleared (one-shot actions), and 'act:<action>' for gamepad buttons and the mouse wheel
  readonly pressed = new Set<string>();
  bindings: Bindings = copyBindings(DEFAULT_BINDINGS);
  padDeadzone = PAD_DEADZONE.medium;
  // Mouse driving: the cursor stays visible; its distance left/right of the screen centre sets the wheel.
  // Left button = throttle, right = brake, scroll = shift. `active` is set by the game while driving.
  readonly mouse = {
    enabled: false, active: false, steer: 0,
    x: null as number | null,                    // last cursor x; null until the mouse moves over the page
    range: MOUSE_RANGE.medium, deadzone: MOUSE_DEADZONE.small,
    lmb: false, rmb: false,
  };
  private readonly state: DriveInput = { throttle: 0, brake: 0, steer: 0, analog: false, steerAngle: null };
  private kThrottle = 0; private kBrake = 0;     // keyboard pedals ramp in and out
  private readonly padPrev: boolean[] = [];
  private readonly menuPadPrev: boolean[] = [];

  constructor() {
    addEventListener('mousedown', (e) => {
      const m = this.mouse;
      if (!m.enabled || !m.active) return;
      if (e.button === 0) m.lmb = true;
      else if (e.button === 2) m.rmb = true;
      else if (e.button === 1) e.preventDefault();   // no autoscroll
    });
    addEventListener('mouseup', (e) => { if (e.button === 0) this.mouse.lmb = false; else if (e.button === 2) this.mouse.rmb = false; });
    addEventListener('contextmenu', (e) => { if (this.mouse.enabled && this.mouse.active) e.preventDefault(); });
    addEventListener('mousemove', (e) => { this.mouse.x = e.clientX; });
    addEventListener('wheel', (e) => {
      if (!this.mouse.enabled || !this.mouse.active) return;
      e.preventDefault();
      this.pressed.add(e.deltaY < 0 ? 'act:shiftUp' : 'act:shiftDown');
    }, { passive: false });
    addEventListener('blur', () => { this.mouse.lmb = this.mouse.rmb = false; });
    addEventListener('keydown', (e) => {
      // no page scrolling from the driving keys (but typing in a text field, e.g. the circuit search, works)
      const typing = e.target instanceof HTMLInputElement && e.target.type !== 'range';
      if (!typing && (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key) || this.isBound(e.code))) e.preventDefault();
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }
  takePressed(code: string) { const h = this.pressed.has(code); this.pressed.delete(code); return h; }
  // A one-shot action: one of its keys, its gamepad button or (shifts) the mouse wheel since the last clear.
  takeAction(a: Action) {
    let hit = this.takePressed('act:' + a);
    for (const c of this.bindings[a]) if (c && this.takePressed(c)) hit = true;
    return hit;
  }
  private held(a: Action) { const [c0, c1] = this.bindings[a]; return (c0 != null && this.keys.has(c0)) || (c1 != null && this.keys.has(c1)); }
  private isBound(code: string) { for (const k in this.bindings) if (this.bindings[k as Action].includes(code)) return true; return false; }
  setMouse(on: boolean) { this.mouse.enabled = on; this.mouse.steer = 0; this.mouse.lmb = this.mouse.rmb = false; }
  mouseSteer() {
    const m = this.mouse;
    if (m.x == null) return 0;   // cursor hasn't moved over the page yet
    const half = innerWidth / 2, d = (m.x - half) / half;   // -1 (left edge) .. 1 (right edge)
    const t = clamp((Math.abs(d) - m.deadzone) / (m.range - m.deadzone), 0, 1);
    return -Math.sign(d) * t;
  }
  poll(dt: number): DriveInput {
    const st = this.state;
    const up = this.held('throttle'), dn = this.held('brake'), lf = this.held('left'), rt = this.held('right');
    const m = this.mouse, mouseOn = m.enabled && m.active;
    m.steer = mouseOn ? this.mouseSteer() : 0;
    this.kThrottle = clamp(this.kThrottle + (up || (mouseOn && m.lmb) ? 8 : -10) * dt, 0, 1);
    this.kBrake = clamp(this.kBrake + (dn || (mouseOn && m.rmb) ? 10 : -12) * dt, 0, 1);
    st.throttle = this.kThrottle; st.brake = this.kBrake; st.steer = (lf ? 1 : 0) - (rt ? 1 : 0); st.analog = false;
    if (mouseOn && !lf && !rt) { st.steer = m.steer; st.analog = true; }   // steering keys still override
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p) continue;
      const ax = p.axes[0] || 0, rtv = p.buttons[7]?.value || 0, ltv = p.buttons[6]?.value || 0;
      const dz = this.padDeadzone;
      if (Math.abs(ax) > dz || rtv > 0.05 || ltv > 0.05) {
        // Inside the dead zone the stick is centred (the curve's base would be negative, and its power NaN).
        const t = Math.max(0, (Math.abs(ax) - dz) / (1 - dz));
        st.steer = t > 0 ? -Math.sign(ax) * Math.pow(t, PAD_CURVE) : 0;
        st.throttle = Math.max(st.throttle, rtv); st.brake = Math.max(st.brake, ltv); st.analog = true;
      }
      for (const [bi, a] of PAD_BUTTONS) {
        const down = !!p.buttons[bi]?.pressed;
        if (down && !this.padPrev[bi]) this.pressed.add('act:' + a);
        this.padPrev[bi] = down;
      }
      break;
    }
    return st;
  }
  // Gamepad buttons newly pressed since the last call, as menu keys (ArrowUp, Enter, Escape, TabNext...). The game
  // calls it every frame, so a button already held when the menu opens doesn't count.
  pollMenuPad(): string[] {
    const out: string[] = [];
    const p = (navigator.getGamepads ? navigator.getGamepads() : []).find((g) => g);
    if (!p) return out;
    const stick = p.axes[1] || 0;
    for (const [bi, code] of PAD_MENU) {
      const down = !!p.buttons[bi]?.pressed || (bi === 12 && stick < -0.6) || (bi === 13 && stick > 0.6);
      if (down && !this.menuPadPrev[bi] && !out.includes(code)) out.push(code);
      this.menuPadPrev[bi] = down;
    }
    return out;
  }
}
