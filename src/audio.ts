import { SoundGraph, type AudioCar } from './audioGraph';

// ============================================================================
// Audio: owns the AudioContext and its lifecycle; the sound itself is in audioGraph.ts.
// The context is created on the first user gesture (browser autoplay policy), fades out and suspends while muted or
// while the tab is hidden, and resumes when sound is wanted again.
// ============================================================================
const GESTURES = ['pointerdown', 'keydown', 'touchend'] as const;
const SUSPEND_AFTER = 300;   // ms: let the fade-out finish before suspending

export class EngineAudio {
  muted = false;
  private ctx: AudioContext | null = null;
  private graph: SoundGraph | null = null;
  private suspendTimer = 0;

  constructor() {
    for (const ev of GESTURES) window.addEventListener(ev, this.start, { capture: true, passive: true });
    document.addEventListener('visibilitychange', this.sync);
  }

  // Create the context (only inside a user gesture), or resume it if it should be running. Safe to call any time.
  start = () => {
    if (!this.ctx) {
      const ua = (navigator as { userActivation?: UserActivation }).userActivation;
      if (ua && !ua.isActive) return;   // e.g. Escape doesn't count as a gesture; wait for one that does
      try {
        const ctx = new AudioContext({ latencyHint: 'interactive' });
        this.graph = new SoundGraph(ctx, ctx.destination);
        this.ctx = ctx;
      } catch { this.ctx = null; this.graph = null; return; }
      this.sync();
    } else if (this.ctx.state !== 'running' && this.wanted()) this.sync();   // e.g. interrupted by the system
  };

  setMuted(m: boolean) { this.muted = m; this.sync(); }

  // Once per frame. active: driving (not paused or in the menu); the game sounds fade out otherwise.
  update(car: AudioCar, dt: number, active: boolean) {
    const ctx = this.ctx;
    if (ctx && this.graph && ctx.state === 'running') this.graph.update(car, dt, active, ctx.currentTime);
  }

  // Fade the master in or out to match mute and tab visibility; suspend the context once it is silent.
  private sync = () => {
    const ctx = this.ctx, g = this.graph;
    if (!ctx || !g) return;
    clearTimeout(this.suspendTimer);
    if (this.wanted()) {
      // resume() can take a while; if sound stopped being wanted meanwhile, suspend again
      if (ctx.state !== 'running') ctx.resume().then(() => { if (!this.wanted()) this.sync(); }, () => {});
      g.setLevel(1, ctx.currentTime);
    } else {
      g.setLevel(0, ctx.currentTime, 0.04);
      this.suspendTimer = window.setTimeout(() => { if (!this.wanted()) ctx.suspend().catch(() => {}); }, SUSPEND_AFTER);
    }
  };
  private wanted() { return !this.muted && !document.hidden; }
}
