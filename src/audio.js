import { clamp } from './util.js';

// ============================================================================
// Audio: simple synthesized engine + tyre noise
// ============================================================================
export class EngineAudio {
  constructor() { this.ctx = null; this.muted = false; }
  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      const ctx = (this.ctx = new AudioContext());
      this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.5; this.master.connect(ctx.destination);
      this.filter = ctx.createBiquadFilter(); this.filter.type = 'lowpass'; this.filter.Q.value = 2; this.filter.connect(this.master);
      this.eg = ctx.createGain(); this.eg.gain.value = 0.0; this.eg.connect(this.filter);
      this.oscs = [['sawtooth', 1, 0.5], ['square', 0.5, 0.35], ['sawtooth', 2, 0.18]].map(([type, mul, g]) => {
        const o = ctx.createOscillator(); o.type = type; const gg = ctx.createGain(); gg.gain.value = g;
        o.connect(gg); gg.connect(this.eg); o.start(); return { o, mul };
      });
      const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const mkNoise = (type, freq, q) => {
        const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
        const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
        const g = ctx.createGain(); g.gain.value = 0; src.connect(f); f.connect(g); g.connect(this.master); src.start();
        g.filter = f;
        return g;
      };
      this.tyre = mkNoise('bandpass', 1100, 6);
      this.wind = mkNoise('lowpass', 500, 0.5);
      // Off-track: low rumble on grass; on gravel a brighter noise, amplitude-wobbled so it crunches.
      this.grass = mkNoise('lowpass', 320, 0.7);
      this.gravel = mkNoise('bandpass', 1700, 0.9);
      const am = ctx.createGain(); am.gain.value = 0.6;
      this.gravel.filter.disconnect(); this.gravel.filter.connect(am); am.connect(this.gravel);
      const lfo = ctx.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 19;
      const depth = ctx.createGain(); depth.gain.value = 0.4; lfo.connect(depth); depth.connect(am.gain); lfo.start();
      this.gravelLfo = lfo;
    } catch (e) { this.ctx = null; }
  }
  setMuted(m) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : 0.5; }
  update(car) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, f = car.rpm / car.spec.firingDiv;       // engine firing frequency
    for (const { o, mul } of this.oscs) o.frequency.setTargetAtTime(f * mul, t, 0.015);
    this.filter.frequency.setTargetAtTime(500 + car.throttle * 3200 + car.rpm * 0.1, t, 0.03);
    this.eg.gain.setTargetAtTime(0.05 + 0.13 * car.throttle, t, 0.03);
    const slipSq = clamp(car.maxSlip - 0.9, 0, 1) * (car.speedF > 5 ? 1 : 0) * (car.groundedCount > 0 ? 1 : 0);
    this.tyre.gain.setTargetAtTime(slipSq * 0.25, t, 0.05);
    this.wind.gain.setTargetAtTime(Math.min(0.35, (car.speedF / 90) ** 2 * 0.35), t, 0.1);
    const sp = clamp(Math.abs(car.speedF) / 30, 0, 1);
    this.grass.gain.setTargetAtTime((car.offGrass || 0) / 4 * sp * 0.55, t, 0.05);
    this.grass.filter.frequency.setTargetAtTime(220 + sp * 260, t, 0.05);
    this.gravel.gain.setTargetAtTime((car.offGravel || 0) / 4 * sp * 0.5, t, 0.05);
    this.gravelLfo.frequency.setTargetAtTime(9 + Math.abs(car.speedF) * 0.6, t, 0.05);
  }
}
