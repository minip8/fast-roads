import type { Car } from './car';
import { clamp } from './util';

// ============================================================================
// Audio: simple synthesized engine + tyre noise
// ============================================================================
interface Noise { gain: GainNode; filter: BiquadFilterNode }

function buildGraph(ctx: AudioContext, muted: boolean) {
  const master = ctx.createGain(); master.gain.value = muted ? 0 : 0.5; master.connect(ctx.destination);
  const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.Q.value = 2; filter.connect(master);
  const eg = ctx.createGain(); eg.gain.value = 0.0; eg.connect(filter);
  const voices: [OscillatorType, number, number][] = [['sawtooth', 1, 0.5], ['square', 0.5, 0.35], ['sawtooth', 2, 0.18]];
  const oscs = voices.map(([type, mul, g]) => {
    const o = ctx.createOscillator(); o.type = type; const gg = ctx.createGain(); gg.gain.value = g;
    o.connect(gg); gg.connect(eg); o.start(); return { o, mul };
  });
  const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const mkNoise = (type: BiquadFilterType, freq: number, q: number): Noise => {
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); g.gain.value = 0; src.connect(f); f.connect(g); g.connect(master); src.start();
    return { gain: g, filter: f };
  };
  const tyre = mkNoise('bandpass', 1100, 6);
  const wind = mkNoise('lowpass', 500, 0.5);
  // Off-track: low rumble on grass; on gravel a brighter noise, amplitude-wobbled so it crunches.
  const grass = mkNoise('lowpass', 320, 0.7);
  const gravel = mkNoise('bandpass', 1700, 0.9);
  const am = ctx.createGain(); am.gain.value = 0.6;
  gravel.filter.disconnect(); gravel.filter.connect(am); am.connect(gravel.gain);
  const gravelLfo = ctx.createOscillator(); gravelLfo.type = 'square'; gravelLfo.frequency.value = 19;
  const depth = ctx.createGain(); depth.gain.value = 0.4; gravelLfo.connect(depth); depth.connect(am.gain); gravelLfo.start();
  return { master, filter, eg, oscs, tyre, wind, grass, gravel, gravelLfo };
}

export class EngineAudio {
  muted = false;
  private ctx: AudioContext | null = null;
  private g: ReturnType<typeof buildGraph> | null = null;

  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      this.ctx = new AudioContext();
      this.g = buildGraph(this.ctx, this.muted);
    } catch { this.ctx = null; this.g = null; }
  }
  setMuted(m: boolean) { this.muted = m; if (this.g) this.g.master.gain.value = m ? 0 : 0.5; }
  update(car: Car) {
    const ctx = this.ctx, g = this.g;
    if (!ctx || !g) return;
    const t = ctx.currentTime, f = car.rpm / car.spec.firingDiv;       // engine firing frequency
    for (const { o, mul } of g.oscs) o.frequency.setTargetAtTime(f * mul, t, 0.015);
    g.filter.frequency.setTargetAtTime(500 + car.throttle * 3200 + car.rpm * 0.1, t, 0.03);
    g.eg.gain.setTargetAtTime(0.05 + 0.13 * car.throttle, t, 0.03);
    const slipSq = clamp(car.maxSlip - 0.9, 0, 1) * (car.speedF > 5 ? 1 : 0) * (car.groundedCount > 0 ? 1 : 0);
    g.tyre.gain.gain.setTargetAtTime(slipSq * 0.25, t, 0.05);
    g.wind.gain.gain.setTargetAtTime(Math.min(0.35, (car.speedF / 90) ** 2 * 0.35), t, 0.1);
    const sp = clamp(Math.abs(car.speedF) / 30, 0, 1);
    g.grass.gain.gain.setTargetAtTime(car.offGrass / 4 * sp * 0.55, t, 0.05);
    g.grass.filter.frequency.setTargetAtTime(220 + sp * 260, t, 0.05);
    g.gravel.gain.gain.setTargetAtTime(car.offGravel / 4 * sp * 0.5, t, 0.05);
    g.gravelLfo.frequency.setTargetAtTime(9 + Math.abs(car.speedF) * 0.6, t, 0.05);
  }
}
