import type { CarId } from './cars';
import { S_GRASS, S_GRAVEL, S_KERB } from './config';
import { clamp } from './util';

// ============================================================================
// Sound graph: every node is created once here; update() only moves parameters (with setTargetAtTime, so nothing
// clicks or zippers). Works on any BaseAudioContext, so it can also be rendered offline.
//
//   engine:  2 x oscillator (per-car harmonic wave) -> roughness AM -> lowpass (opens with throttle) -> body peak
//            -> shift cut -> rev limiter chop -> level
//   tyres:   noise -> 2 narrow bandpasses (squeal, pitch wobble) + broad bandpass (scrub)
//   surface: road roar, kerb rumble (chopped at the rumble-strip rate), grass rumble, gravel crunch
//   wind:    noise -> bandpass rising with speed
//   impact:  falling sine + low noise burst, fired on a sudden change of velocity
//   all -> bus (silent when paused) -> compressor -> soft clipper -> master (mute) -> destination
// ============================================================================

// Everything the sound reads from the car. Car satisfies it as is; tests and offline renders can pass snapshots.
export interface AudioCar {
  readonly spec: { readonly id: CarId; readonly sound: EngineVoice; readonly redline: number; readonly idle: number };
  readonly rpm: number; readonly throttle: number; readonly gear: number; readonly speedF: number;
  readonly vel: { readonly x: number; readonly y: number; readonly z: number };
  readonly pos: { readonly x: number; readonly y: number; readonly z: number };
  readonly wheels: readonly { readonly surf: number; readonly slip: number; readonly grounded: boolean }[];
}

// A car's engine and tyre sound (CarSpec.sound).
export interface EngineVoice {
  firingDiv: number;         // rpm / this = firing frequency
  harmonics: number[];       // amplitudes of the harmonics of half the firing frequency (index 0 = f/2)
  detune: number;            // cents: second oscillator, for slow beating between "banks"
  level: number;             // engine gain at full throttle and redline
  coast: number;             // share of that level off the throttle
  bright: [coast: number, load: number];   // lowpass cutoff, in multiples of the firing frequency
  body: [hz: number, q: number, dbCoast: number, dbLoad: number];   // fixed exhaust/airbox resonance
  rough: number;             // random amplitude wobble (uneven firing), 0..1
  squealHz: number;          // tyre squeal pitch
}

// Layer levels at full effect (white noise through a narrow filter is quiet, hence the big numbers).
const MIX = { squeal: 3, scrub: 0.1, road: 0.5, kerb: 3, grass: 1.1, gravel: 0.4, wind: 0.3, thudTone: 0.35, thudNoise: 2 };
const BUS_LEVEL = 0.75;       // into the compressor (which adds make-up gain)
const RUMBLE_PERIOD = 1.5;     // m: kerb rumble-strip spacing (track.ts kerbHeight: sin(s * 4.19))
const IMPACT_ACCEL = 90;       // m/s^2: velocity changes sharper than this (no car brakes that hard) are impacts

type Src = AudioScheduledSourceNode;

export class SoundGraph {
  readonly master: GainNode;
  private readonly bus: GainNode;
  private readonly waves = new Map<CarId, PeriodicWave>();   // each car's engine wave, built when first needed
  // engine
  private readonly osc: OscillatorNode[];
  private readonly roughDepth: GainNode;
  private readonly engLow: BiquadFilterNode;
  private readonly engBody: BiquadFilterNode;
  private readonly shift: GainNode;
  private readonly limiter: GainNode;
  private readonly limDepth: GainNode;
  private readonly limPitch: GainNode;
  private readonly engine: GainNode;
  // tyres
  private readonly squealF: BiquadFilterNode[];
  private readonly squeal: GainNode;
  private readonly scrub: GainNode;
  // surfaces, wind
  private readonly road: GainNode; private readonly roadF: BiquadFilterNode;
  private readonly kerb: GainNode; private readonly kerbLfo: OscillatorNode;
  private readonly grass: GainNode; private readonly grassF: BiquadFilterNode;
  private readonly gravel: GainNode; private readonly gravelMod: AudioBufferSourceNode;
  private readonly wind: GainNode; private readonly windF: BiquadFilterNode;
  // impact
  private readonly thudOsc: OscillatorNode; private readonly thudTone: GainNode; private readonly thudNoise: GainNode;
  // per-frame state
  private voiceId: CarId | null = null;
  private car: AudioCar | null = null;
  private gear = 0;
  private wasActive = false;
  private pv = { x: 0, y: 0, z: 0 }; private pp = { x: 0, y: 0, z: 0 };
  private thudReady = 0;

  constructor(private readonly ctx: BaseAudioContext, dest: AudioNode) {
    const gain = (v: number, to?: AudioNode | AudioParam) => { const g = ctx.createGain(); g.gain.value = v; if (to) g.connect(to as AudioNode); return g; };
    const filter = (type: BiquadFilterType, hz: number, q: number, to?: AudioNode) => {
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = hz; f.Q.value = q; if (to) f.connect(to); return f;
    };
    const sources: [Src, number][] = [];   // started together at the end (noise readers at different offsets)

    // Output stage. The compressor keeps the sum in range; the clipper only catches what slips past its attack.
    this.master = gain(0, dest);
    const clip = ctx.createWaveShaper(); clip.curve = softClipCurve(); clip.connect(this.master);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -8; comp.knee.value = 6; comp.ratio.value = 12; comp.attack.value = 0.003; comp.release.value = 0.25;
    comp.connect(clip);
    this.bus = gain(0, comp);

    // Shared sources: white noise (several decorrelated readers) and a smooth random modulator (4-40 Hz).
    const sr = ctx.sampleRate;
    const white = ctx.createBuffer(1, Math.round(sr * 3.7), sr), wd = white.getChannelData(0);
    for (let i = 0; i < wd.length; i++) wd[i] = Math.random() * 2 - 1;
    const modBuf = ctx.createBuffer(1, Math.round(sr * 4), sr);
    smoothNoise(modBuf.getChannelData(0), sr, 4);
    const noise = (offset: number) => {
      const s = ctx.createBufferSource(); s.buffer = white; s.loop = true; sources.push([s, offset]); return s;
    };
    const modSrc = (rate: number) => {
      const s = ctx.createBufferSource(); s.buffer = modBuf; s.loop = true; s.playbackRate.value = rate; sources.push([s, 0]); return s;
    };
    const nA = noise(0), nB = noise(1.3), nC = noise(2.6);
    const mod = modSrc(1);

    // ---- engine
    this.engine = gain(0, this.bus);
    this.limiter = gain(1, this.engine);
    this.shift = gain(1, this.limiter);
    this.engBody = filter('peaking', 1000, 1, this.shift);
    this.engLow = filter('lowpass', 1000, 0.8, this.engBody);
    const hp = filter('highpass', 30, 0.7, this.engLow);
    const rough = gain(1, hp);
    this.roughDepth = gain(0, rough.gain); mod.connect(this.roughDepth);
    const mix = gain(1, rough);
    this.osc = [0, 1].map((k) => {
      const o = ctx.createOscillator(); o.frequency.value = 100;   // wave set by update() for the car
      o.connect(k ? gain(0.35, mix) : mix); sources.push([o, 0]); return o;
    });
    // Rev limiter: a softened square chops the level (and dips the pitch) while on the limiter.
    const limLfo = ctx.createOscillator(); limLfo.type = 'square'; limLfo.frequency.value = 22; sources.push([limLfo, 0]);
    const limSmooth = filter('lowpass', 90, 0.5); limLfo.connect(limSmooth);
    this.limDepth = gain(0, this.limiter.gain); limSmooth.connect(this.limDepth);
    this.limPitch = gain(0); limSmooth.connect(this.limPitch);
    for (const o of this.osc) this.limPitch.connect(o.detune);

    // ---- tyres: two narrow bands give the whistle, the pitch wobbles a little; a broad band adds scrub.
    const tyre = gain(1, this.bus);
    this.squeal = gain(0, tyre);
    this.squealF = [[1, 16, 1], [1.93, 12, 0.45]].map(([mul, q, g]) => { const f = filter('bandpass', 900 * mul, q, gain(g, this.squeal)); nA.connect(f); return f; });
    const wobble = ctx.createOscillator(); wobble.frequency.value = 5.3; sources.push([wobble, 0]);
    const wobDepth = gain(35); wobble.connect(wobDepth);
    const jitDepth = gain(180); mod.connect(jitDepth);
    for (const f of this.squealF) { wobDepth.connect(f.detune); jitDepth.connect(f.detune); }
    this.scrub = gain(0, tyre);
    nA.connect(filter('bandpass', 1800, 0.8, this.scrub));

    // ---- road roar (asphalt), kerb rumble, grass, gravel, wind
    this.road = gain(0, this.bus); this.roadF = filter('lowpass', 200, 0.7, this.road); nB.connect(this.roadF);

    this.kerb = gain(0, this.bus);
    const kerbAm = gain(0.5, this.kerb);
    nB.connect(filter('lowpass', 150, 1.4, kerbAm));
    this.kerbLfo = ctx.createOscillator(); this.kerbLfo.type = 'triangle'; this.kerbLfo.frequency.value = 20; sources.push([this.kerbLfo, 0]);
    this.kerbLfo.connect(gain(0.5, kerbAm.gain));

    this.grass = gain(0, this.bus);
    const grassAm = gain(1, this.grass); mod.connect(gain(0.35, grassAm.gain));
    this.grassF = filter('lowpass', 300, 0.7, grassAm); nB.connect(this.grassF);

    this.gravel = gain(0, this.bus);
    const gravelAm = gain(0.9, this.gravel);
    this.gravelMod = modSrc(2); this.gravelMod.connect(gain(0.9, gravelAm.gain));
    nC.connect(filter('bandpass', 1500, 0.9, gravelAm));

    this.wind = gain(0, this.bus); this.windF = filter('bandpass', 500, 0.6, this.wind); nA.connect(this.windF);

    // ---- impact
    this.thudTone = gain(0, this.bus); this.thudNoise = gain(0, this.bus);
    this.thudOsc = ctx.createOscillator(); this.thudOsc.frequency.value = 50; this.thudOsc.connect(this.thudTone); sources.push([this.thudOsc, 0]);
    nC.connect(filter('lowpass', 260, 0.8, this.thudNoise));

    for (const [s, off] of sources) { if (off) (s as AudioBufferSourceNode).start(0, off); else s.start(); }
  }

  // Master level (mute fade).
  setLevel(level: number, t: number, tc = 0.05) { this.master.gain.setTargetAtTime(level, t, tc); }

  // Once per frame. dt: frame time (s); active: driving (not paused / in the menu); t: the context's current time.
  update(car: AudioCar, dt: number, active: boolean, t: number) {
    const v = car.spec.sound, abs = Math.abs(car.speedF);
    if (this.voiceId !== car.spec.id) {   // switching car happens in the menu, while the bus is silent
      this.voiceId = car.spec.id;
      let wave = this.waves.get(car.spec.id);
      if (!wave) this.waves.set(car.spec.id, (wave = harmonicWave(this.ctx, v.harmonics)));
      for (const o of this.osc) o.setPeriodicWave(wave);
      this.osc[1].detune.value = v.detune;
      this.engBody.frequency.value = v.body[0]; this.engBody.Q.value = v.body[1];
      this.roughDepth.gain.value = v.rough;
    }
    const fresh = car !== this.car || !this.wasActive;
    this.car = car; this.wasActive = active;
    this.bus.gain.setTargetAtTime(active ? BUS_LEVEL : 0, t, active ? 0.08 : 0.04);

    // ---- engine
    const thr = clamp(car.throttle, 0, 1);
    const rpmN = clamp(car.rpm / car.spec.redline, 0, 1.1);
    const fire = Math.max(car.rpm, car.spec.idle * 0.9) / v.firingDiv;
    for (const o of this.osc) o.frequency.setTargetAtTime(fire / 2, t, 0.012);
    this.engLow.frequency.setTargetAtTime(clamp(fire * (v.bright[0] + (v.bright[1] - v.bright[0]) * thr), 150, 14000), t, 0.03);
    this.engBody.gain.setTargetAtTime(v.body[2] + (v.body[3] - v.body[2]) * thr, t, 0.05);
    this.engine.gain.setTargetAtTime(v.level * (v.coast + (1 - v.coast) * thr) * (0.7 + 0.3 * rpmN), t, 0.03);
    const onLimiter = car.gear > 0 && thr > 0.3 && car.rpm >= car.spec.redline * 0.99 ? 1 : 0;
    this.limDepth.gain.setTargetAtTime(-0.42 * onLimiter, t, 0.02);   // limiter gain swings 1 -> ~0.16
    this.limiter.gain.setTargetAtTime(1 - 0.42 * onLimiter, t, 0.02);
    this.limPitch.gain.setTargetAtTime(-30 * onLimiter, t, 0.02);      // cents
    if (!fresh && active && car.gear !== this.gear && car.gear > 0 && this.gear > 0) {
      const g = this.shift.gain;
      if (car.gear > this.gear) { g.setTargetAtTime(0.3, t, 0.006); g.setTargetAtTime(1, t + 0.05, 0.02); }   // ignition cut
      else { g.setTargetAtTime(1.25, t, 0.01); g.setTargetAtTime(1, t + 0.07, 0.04); }                       // throttle blip
    }
    this.gear = car.gear;

    // ---- tyres and surfaces
    let squeal = 0, squealMax = 0, onRoad = 0, onKerb = 0, onGrass = 0, onGravel = 0;
    for (const w of car.wheels) {
      if (!w.grounded) continue;
      if (w.surf === S_GRASS) onGrass++;
      else if (w.surf === S_GRAVEL) onGravel++;
      else {
        onRoad++; if (w.surf === S_KERB) onKerb++;
        const x = clamp((w.slip - 0.6) / 1.2, 0, 1);   // ~0.6: a little under the peak slip angle
        squeal += x; squealMax = Math.max(squealMax, x);
      }
    }
    const n = car.wheels.length || 1;
    const sq = clamp(0.65 * squealMax + 0.35 * squeal / n, 0, 1) * clamp(abs / 2, 0, 1);
    this.squeal.gain.setTargetAtTime(MIX.squeal * sq ** 1.3, t, 0.04);
    this.scrub.gain.setTargetAtTime(MIX.scrub * sq * sq, t, 0.05);
    for (let k = 0; k < this.squealF.length; k++) this.squealF[k].frequency.setTargetAtTime(v.squealHz * (k ? 1.93 : 1) * (0.92 + 0.25 * sq), t, 0.08);

    const sp = clamp(abs / 30, 0, 1);
    this.road.gain.setTargetAtTime(MIX.road * clamp(abs / 70, 0, 1) * onRoad / n, t, 0.08);
    this.roadF.frequency.setTargetAtTime(160 + abs * 4, t, 0.1);
    this.kerb.gain.setTargetAtTime(MIX.kerb * clamp(abs / 8, 0, 1) * onKerb / n, t, 0.025);
    this.kerbLfo.frequency.setTargetAtTime(clamp(abs / RUMBLE_PERIOD, 2, 90), t, 0.05);
    this.grass.gain.setTargetAtTime(MIX.grass * sp * onGrass / n, t, 0.05);
    this.grassF.frequency.setTargetAtTime(200 + sp * 260, t, 0.05);
    this.gravel.gain.setTargetAtTime(MIX.gravel * sp * onGravel / n, t, 0.05);
    this.gravelMod.playbackRate.setTargetAtTime(0.6 + abs / 12, t, 0.1);
    this.wind.gain.setTargetAtTime(MIX.wind * Math.min(1, (abs / 85) ** 2), t, 0.1);
    this.windF.frequency.setTargetAtTime(350 + abs * 9, t, 0.1);

    // ---- impact: a velocity change no brake or tyre can produce, unless the car was just teleported (reset)
    const pv = this.pv, pp = this.pp, vel = car.vel, pos = car.pos;
    if (!fresh && active && dt > 0 && t >= this.thudReady) {
      const dv = Math.hypot(vel.x - pv.x, vel.z - pv.z, 0.5 * (vel.y - pv.y));
      const moved = Math.hypot(pos.x - pp.x, pos.z - pp.z);
      const accel = dv / Math.max(dt, 1 / 120);
      if (accel > IMPACT_ACCEL && moved < Math.hypot(pv.x, pv.z) * dt * 2 + 1) this.thud(clamp((accel - IMPACT_ACCEL) / 500, 0.15, 1), t);
    }
    pv.x = vel.x; pv.y = vel.y; pv.z = vel.z; pp.x = pos.x; pp.y = pos.y; pp.z = pos.z;
  }

  private thud(k: number, t: number) {
    this.thudReady = t + 0.25;
    const f = this.thudOsc.frequency, a = this.thudTone.gain, b = this.thudNoise.gain;
    f.setValueAtTime(70 + 70 * k, t); f.setTargetAtTime(38, t, 0.06);
    a.setTargetAtTime(MIX.thudTone * k, t, 0.003); a.setTargetAtTime(0, t + 0.03, 0.09);
    b.setTargetAtTime(MIX.thudNoise * k, t, 0.002); b.setTargetAtTime(0, t + 0.015, 0.05);
  }
}

// Wave with the given harmonic amplitudes (sine phase), normalised by the browser.
function harmonicWave(ctx: BaseAudioContext, amps: number[]) {
  const re = new Float32Array(amps.length + 1), im = new Float32Array(amps.length + 1);
  amps.forEach((a, k) => { im[k + 1] = a; });
  return ctx.createPeriodicWave(re, im);
}

// Smooth random signal in -1..1 that loops seamlessly: a sum of sines with whole cycles over the buffer.
function smoothNoise(d: Float32Array, sr: number, seconds: number) {
  const parts: [w: number, ph: number, a: number][] = [];
  for (let k = 0; k < 12; k++) {
    const hz = Math.round((4 + 36 * Math.random() ** 1.5) * seconds) / seconds;
    parts.push([2 * Math.PI * hz / sr, Math.random() * 2 * Math.PI, 1]);
  }
  let peak = 0;
  for (let i = 0; i < d.length; i++) {
    let s = 0; for (const [w, ph, a] of parts) s += a * Math.sin(w * i + ph);
    d[i] = s; peak = Math.max(peak, Math.abs(s));
  }
  for (let i = 0; i < d.length; i++) d[i] /= peak;
}

// Linear up to 0.7, then a smooth knee that never passes 1.
function softClipCurve() {
  const n = 2048, c = new Float32Array(n), k = 0.7;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x);
    c[i] = Math.sign(x) * (a <= k ? a : k + (1 - k) * Math.tanh((a - k) / (1 - k)));
  }
  return c;
}
