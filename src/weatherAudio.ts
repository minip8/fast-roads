import { clamp } from './util';

// ============================================================================
// Weather sound (part of the sound graph, audioGraph.ts, built the first time it rains or the track is wet):
//   rain:    noise -> highpass -> lowpass (the steady hiss of rain all round), and a loop of single drops
//            (short decaying ticks and a few heavier plops) -> bandpass: the patter on the car and the road
//   tyres:   noise -> bandpass rising with speed (the hiss of tyres through a water film), and noise -> lowpass with a
//            slow wobble (the swish through standing water)
// Levels from weatherSound(), which tests check; all into the graph's bus (silent while paused, compressed).
// ============================================================================
export interface WeatherSoundLevels { rain: number; patter: number; hiss: number; swish: number; hissHz: number }

// What the weather sounds like: rain 0..1, wetness 0..1 (the road), speed m/s, onRoad: share of the wheels on the
// asphalt or kerbs (on grass and gravel the surface has its own sound).
export function weatherSound(rain: number, wetness: number, speed: number, onRoad: number,
  out: WeatherSoundLevels = { rain: 0, patter: 0, hiss: 0, swish: 0, hissHz: 0 }) {
  rain = clamp(rain, 0, 1); wetness = clamp(wetness, 0, 1);
  const sp = clamp(Math.abs(speed) / 70, 0, 1.3), film = clamp(wetness / 0.5, 0, 1);
  out.rain = rain ** 0.7;
  out.patter = clamp((rain - 0.03) / 0.97, 0, 1) ** 0.8;
  out.hiss = film * sp ** 1.4 * clamp(onRoad, 0, 1) * clamp(Math.abs(speed) / 3, 0, 1);
  out.swish = clamp((wetness - 0.5) / 0.5, 0, 1) * sp ** 1.2 * clamp(onRoad, 0, 1);
  out.hissHz = 1300 + Math.abs(speed) * 38;
  return out;
}

// Layer levels at full effect (filtered white noise is quiet, hence the big numbers).
export const WEATHER_MIX = { rain: 0.14, patter: 0.3, hiss: 0.2, swish: 0.22 };

export class WeatherSound {
  private readonly rain: GainNode; private readonly patter: GainNode;
  private readonly hiss: GainNode; private readonly hissF: BiquadFilterNode;
  private readonly swish: GainNode;
  private readonly lv: WeatherSoundLevels = { rain: 0, patter: 0, hiss: 0, swish: 0, hissHz: 0 };

  constructor(ctx: BaseAudioContext, dest: AudioNode) {
    const gain = (v: number, to?: AudioNode | AudioParam) => { const g = ctx.createGain(); g.gain.value = v; if (to) g.connect(to as AudioNode); return g; };
    const filter = (type: BiquadFilterType, hz: number, q: number, to?: AudioNode) => {
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = hz; f.Q.value = q; if (to) f.connect(to); return f;
    };
    const sr = ctx.sampleRate;
    const white = ctx.createBuffer(1, Math.round(sr * 2.9), sr), wd = white.getChannelData(0);
    for (let i = 0; i < wd.length; i++) wd[i] = Math.random() * 2 - 1;
    const drops = ctx.createBuffer(1, Math.round(sr * 3.1), sr);
    dropLoop(drops.getChannelData(0), sr);
    const src = (buf: AudioBuffer, offset: number) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(0, offset); return s; };

    this.rain = gain(0, dest);
    src(white, 0).connect(filter('highpass', 450, 0.6, filter('lowpass', 6500, 0.5, this.rain)));
    this.patter = gain(0, dest);
    src(drops, 0).connect(filter('bandpass', 2600, 0.45, this.patter));

    const tyreNoise = src(white, 1.37);
    this.hiss = gain(0, dest);
    this.hissF = filter('bandpass', 2000, 0.7, this.hiss); tyreNoise.connect(this.hissF);
    this.swish = gain(0, dest);
    const wob = gain(0.75, this.swish);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 2.3; lfo.connect(gain(0.25, wob.gain)); lfo.start();
    tyreNoise.connect(filter('lowpass', 800, 0.7, wob));
  }

  // Once per frame (t: the context's time).
  update(rain: number, wetness: number, speed: number, onRoad: number, t: number) {
    const l = weatherSound(rain, wetness, speed, onRoad, this.lv);
    this.rain.gain.setTargetAtTime(WEATHER_MIX.rain * l.rain, t, 0.3);
    this.patter.gain.setTargetAtTime(WEATHER_MIX.patter * l.patter, t, 0.3);
    this.hiss.gain.setTargetAtTime(WEATHER_MIX.hiss * l.hiss, t, 0.08);
    this.hissF.frequency.setTargetAtTime(l.hissHz, t, 0.1);
    this.swish.gain.setTargetAtTime(WEATHER_MIX.swish * l.swish, t, 0.08);
  }
}

// A loop of raindrops landing near by: many short high ticks (a few ms) and a few heavier, lower plops, at random
// times; their tails wrap round the end so the loop is seamless.
function dropLoop(d: Float32Array, sr: number) {
  const n = d.length, seconds = n / sr;
  const add = (count: number, hz: [number, number], decay: [number, number], amp: [number, number]) => {
    for (let k = 0; k < count; k++) {
      const at = Math.floor(Math.random() * n), f = hz[0] + Math.random() * (hz[1] - hz[0]);
      const tau = decay[0] + Math.random() * (decay[1] - decay[0]), a = amp[0] + (amp[1] - amp[0]) * Math.random() ** 2;
      const len = Math.min(n, Math.round(tau * sr * 6)), w = (2 * Math.PI * f) / sr, ph = Math.random() * 6.28;
      for (let i = 0; i < len; i++) d[(at + i) % n] += a * Math.exp(-i / (tau * sr)) * Math.sin(w * i + ph);
    }
  };
  add(Math.round(240 * seconds), [2500, 7000], [0.0008, 0.0025], [0.15, 0.7]);
  add(Math.round(22 * seconds), [500, 1400], [0.004, 0.012], [0.3, 1]);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
  for (let i = 0; i < n; i++) d[i] /= peak || 1;
}
