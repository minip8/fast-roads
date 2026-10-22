import { clamp } from './util.js';

// ============================================================================
// Input
// ============================================================================
// Mouse steering: how far the cursor goes from the screen centre (fraction of half the width) for full lock.
export const MOUSE_RANGE = { low: 0.95, medium: 0.7, high: 0.5 };
export const MOUSE_CURVE = 1.7;      // >1 keeps small movements near the centre gentle
// Dead zone: fraction of half the width around the centre that does nothing.
export const MOUSE_DEADZONE = { off: 0, small: 0.03, medium: 0.08, large: 0.15 };

export class Input {
  constructor(canvas) {
    this.keys = new Set(); this.pressed = new Set();
    // Mouse driving: the cursor stays visible; its distance left/right of the screen centre sets the wheel.
    // Left button = throttle, right = brake, scroll = shift. `active` is set by the game while driving.
    this.canvas = canvas;
    this.mouse = { enabled: false, active: false, steer: 0, x: null, range: MOUSE_RANGE.medium, deadzone: MOUSE_DEADZONE.small, lmb: false, rmb: false };
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
      this.pressed.add(e.deltaY < 0 ? 'KeyE' : 'KeyQ');
    }, { passive: false });
    addEventListener('blur', () => { this.mouse.lmb = this.mouse.rmb = false; });
    addEventListener('keydown', (e) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    this.state = { throttle: 0, brake: 0, steer: 0, analog: false, steerAngle: null };
    this.kThrottle = 0; this.kBrake = 0;
    this.padPrev = [];
  }
  takePressed(code) { const h = this.pressed.has(code); this.pressed.delete(code); return h; }
  setMouse(on) { this.mouse.enabled = on; this.mouse.steer = 0; this.mouse.lmb = this.mouse.rmb = false; }
  mouseSteer() {
    const m = this.mouse;
    if (m.x == null) return 0;   // cursor hasn't moved over the page yet
    const half = innerWidth / 2, d = (m.x - half) / half;   // -1 (left edge) .. 1 (right edge)
    const t = clamp((Math.abs(d) - m.deadzone) / (m.range - m.deadzone), 0, 1);
    return -Math.sign(d) * Math.pow(t, MOUSE_CURVE);
  }
  poll(dt) {
    const k = this.keys, st = this.state;
    const up = k.has('KeyW') || k.has('ArrowUp'), dn = k.has('KeyS') || k.has('ArrowDown');
    const lf = k.has('KeyA') || k.has('ArrowLeft'), rt = k.has('KeyD') || k.has('ArrowRight');
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
      if (Math.abs(ax) > 0.08 || rtv > 0.05 || ltv > 0.05) {
        st.steer = -Math.sign(ax) * Math.pow((Math.abs(ax) - 0.08) / 0.92, 1.4) * (Math.abs(ax) > 0.08 ? 1 : 0);
        st.throttle = Math.max(st.throttle, rtv); st.brake = Math.max(st.brake, ltv); st.analog = true;
      }
      const map = { 3: 'KeyC', 2: 'KeyR', 8: 'Enter', 9: 'KeyP', 5: 'KeyE', 4: 'KeyQ' };
      for (const [bi, code] of Object.entries(map)) {
        const down = !!p.buttons[bi]?.pressed;
        if (down && !this.padPrev[bi]) this.pressed.add(code);
        this.padPrev[bi] = down;
      }
      break;
    }
    return st;
  }
}
