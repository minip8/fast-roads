import type { CarId } from './cars';
import { S_GRASS, S_GRAVEL, S_KERB } from './config';
import { loopCount, makeLoop, type EngineLoop, type LoopVoice } from './engineLoops';
import { clamp } from './util';

// ============================================================================
// Sound graph: every node is created once here; update() only moves parameters (with setTargetAtTime, so nothing
// clicks or zippers). Works on any BaseAudioContext, so it can also be rendered offline.
//
//   engine:  2 x oscillator (per-car wave over one engine cycle) -> roughness AM -> lowpass (opens with throttle)
//            -> body peak -> low shelf (weight) -> shift cut -> rev limiter chop -> level
//            or, for a voice with loops (EngineVoice.loops, engineLoops.ts): on-load and overrun loop per rpm point,
//            crossfaded, playbackRate following rpm -> roughness AM -> the same shift cut, limiter and level;
//            plus overrun pops and gear whine (LoopPlayer, built when the voice is first used)
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
  orders: [order: number, amp: number][];   // further crank orders, in halves (0.5 = once per cycle): the uneven firing's rumble
  detune: number;            // cents: second oscillator, for slow beating between "banks"
  level: number;             // engine gain at full throttle and redline
  coast: number;             // share of that level off the throttle
  bright: [coast: number, load: number];   // lowpass cutoff, in multiples of the firing frequency
  body: [hz: number, q: number, dbCoast: number, dbLoad: number];   // fixed exhaust/airbox resonance
  weight: [hz: number, db: number];   // low shelf: the exhaust's and the body's low end
  rough: number;             // random amplitude wobble (uneven firing), 0..1
  squealHz: number;          // tyre squeal pitch
  loops?: LoopVoice;         // synthesised loops in place of the oscillators (which play only while the loops are made)
}

// Layer levels at full effect (white noise through a narrow filter is quiet, hence the big numbers).
const MIX = { squeal: 3, scrub: 0.1, road: 0.5, kerb: 3, grass: 1.1, gravel: 0.4, wind: 0.3, thudTone: 0.35, thudNoise: 2 };
const BUS_LEVEL = 0.75;       // into the compressor (which adds make-up gain)
const RUMBLE_PERIOD = 1.5;     // m: kerb rumble-strip spacing (track.ts kerbHeight: sin(s * 4.19))
const IMPACT_ACCEL = 90;       // m/s^2: velocity changes sharper than this (no car brakes that hard) are impacts

type Src = AudioScheduledSourceNode;

// Tyre noise from the wheels' slip (VehicleWheel.slip: 1 at the tyre's grip peak), 0..1 each, on asphalt and kerbs.
// The squeal marks the limit: silent with grip in hand, it comes in at 90% of the peak slip (where a tyre already gives
// 99% of its grip) and is full a little past the peak. Under that only a faint scrub, growing from half the peak slip,
// so the limit can still be heard coming. The loudest wheel counts most; both fade out at walking pace.
export const SQUEAL_SLIP: readonly [from: number, full: number] = [0.9, 1.15];
export const SCRUB_SLIP: readonly [from: number, share: number] = [0.5, 0.5];   // from, and its share at SQUEAL_SLIP[0]
export function tyreNoise(wheels: AudioCar['wheels'], speed: number, out = { squeal: 0, scrub: 0 }) {
  const [from, full] = SQUEAL_SLIP, [scrubFrom, near] = SCRUB_SLIP;
  let sq = 0, sqMax = 0, sc = 0, scMax = 0;
  for (const w of wheels) {
    if (!w.grounded || w.surf === S_GRASS || w.surf === S_GRAVEL) continue;
    const q = clamp((w.slip - from) / (full - from), 0, 1);
    const c = near * clamp((w.slip - scrubFrom) / (from - scrubFrom), 0, 1) + (1 - near) * q;
    sq += q; sqMax = Math.max(sqMax, q); sc += c; scMax = Math.max(scMax, c);
  }
  const n = wheels.length || 1, fade = clamp(speed / 2, 0, 1);
  out.squeal = clamp(0.65 * sqMax + 0.35 * sq / n, 0, 1) * fade;
  out.scrub = clamp(0.65 * scMax + 0.35 * sc / n, 0, 1) * fade;
  return out;
}

export class SoundGraph {
  readonly master: GainNode;
  private readonly bus: GainNode;
  private readonly waves = new Map<CarId, PeriodicWave>();   // each car's engine wave, built when first needed
  // engine
  private readonly osc: OscillatorNode[];
  private readonly roughDepth: GainNode;
  private readonly engLow: BiquadFilterNode;
  private readonly engBody: BiquadFilterNode;
  private readonly engWeight: BiquadFilterNode;
  private readonly oscOut: GainNode;      // the oscillators' share: 0 while a loop voice plays
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
  // loop voices: players, and the one whose loops are being made (one loop per update, so no frame stalls)
  private readonly players = new Map<LoopVoice, LoopPlayer>();
  private making: { voice: LoopVoice; loops: EngineLoop[] } | null = null;
  private readonly noise: AudioNode;
  private readonly mod: AudioNode;
  // per-frame state
  private voiceId: CarId | null = null;
  private oscOn = true;
  private car: AudioCar | null = null;
  private gear = 0;
  private wasActive = false;
  private pv = { x: 0, y: 0, z: 0 }; private pp = { x: 0, y: 0, z: 0 };
  private thudReady = 0;
  private readonly tn = { squeal: 0, scrub: 0 };

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
    this.noise = nC; this.mod = mod;

    // ---- engine
    this.engine = gain(0, this.bus);
    this.limiter = gain(1, this.engine);
    this.shift = gain(1, this.limiter);
    this.oscOut = gain(1, this.shift);
    this.engWeight = filter('lowshelf', 200, 0.7, this.oscOut);
    this.engBody = filter('peaking', 1000, 1, this.engWeight);
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
      if (!wave) this.waves.set(car.spec.id, (wave = engineWave(this.ctx, v)));
      for (const o of this.osc) o.setPeriodicWave(wave);
      this.osc[1].detune.value = v.detune;
      this.engBody.frequency.value = v.body[0]; this.engBody.Q.value = v.body[1];
      this.engWeight.frequency.value = v.weight[0]; this.engWeight.gain.value = v.weight[1];
      this.roughDepth.gain.value = v.rough;
    }
    const player = v.loops ? this.player(v.loops) : null;   // null until its loops are made
    if (this.oscOn !== !player) { this.oscOn = !player; this.oscOut.gain.setValueAtTime(player ? 0 : 1, t); }
    const fresh = car !== this.car || !this.wasActive;
    this.car = car; this.wasActive = active;
    this.bus.gain.setTargetAtTime(active ? BUS_LEVEL : 0, t, active ? 0.08 : 0.04);

    // ---- engine
    const thr = clamp(car.throttle, 0, 1);
    const rpmN = clamp(car.rpm / car.spec.redline, 0, 1.1);
    const rpm = Math.max(car.rpm, car.spec.idle * 0.9), fire = rpm / v.firingDiv;
    for (const o of this.osc) o.frequency.setTargetAtTime(rpm / 120, t, 0.012);   // the wave is one engine cycle
    this.engLow.frequency.setTargetAtTime(clamp(fire * (v.bright[0] + (v.bright[1] - v.bright[0]) * thr), 150, 14000), t, 0.03);
    this.engBody.gain.setTargetAtTime(v.body[2] + (v.body[3] - v.body[2]) * thr, t, 0.05);
    this.engine.gain.setTargetAtTime(v.level * (v.coast + (1 - v.coast) * thr) * (0.7 + 0.3 * rpmN), t, 0.03);
    for (const p of this.players.values()) p.update(p === player ? car : null, active && !fresh, dt, t);
    const onLimiter = car.gear >= 0 && thr > 0.3 && car.rpm >= car.spec.redline * 0.99 ? 1 : 0;
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
    let onRoad = 0, onKerb = 0, onGrass = 0, onGravel = 0;
    for (const w of car.wheels) {
      if (!w.grounded) continue;
      if (w.surf === S_GRASS) onGrass++;
      else if (w.surf === S_GRAVEL) onGravel++;
      else { onRoad++; if (w.surf === S_KERB) onKerb++; }
    }
    const n = car.wheels.length || 1, tn = tyreNoise(car.wheels, abs, this.tn), sq = tn.squeal;
    this.squeal.gain.setTargetAtTime(MIX.squeal * sq ** 1.3, t, 0.04);
    this.scrub.gain.setTargetAtTime(MIX.scrub * tn.scrub, t, 0.05);
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

  // The player for a loop voice, or null while its loops are still being made (one more each call).
  private player(voice: LoopVoice) {
    const p = this.players.get(voice);
    if (p) return p;
    if (this.making?.voice !== voice) this.making = { voice, loops: [] };
    const loops = this.making.loops;
    loops.push(makeLoop(voice, this.ctx.sampleRate, loops.length));
    if (loops.length < loopCount(voice)) return null;
    this.making = null;
    const player = new LoopPlayer(this.ctx, voice, loops, this.shift, this.bus, this.noise, this.mod, this.limPitch);
    this.players.set(voice, player);
    return player;
  }

  private thud(k: number, t: number) {
    this.thudReady = t + 0.25;
    const f = this.thudOsc.frequency, a = this.thudTone.gain, b = this.thudNoise.gain;
    f.setValueAtTime(70 + 70 * k, t); f.setTargetAtTime(38, t, 0.06);
    a.setTargetAtTime(MIX.thudTone * k, t, 0.003); a.setTargetAtTime(0, t + 0.03, 0.09);
    b.setTargetAtTime(MIX.thudNoise * k, t, 0.002); b.setTargetAtTime(0, t + 0.015, 0.05);
  }
}

// One engine cycle (two crank turns) of a voice: its harmonics of half the firing frequency and its other crank
// orders (harmonic k of the cycle is crank order k / 2), sine phase, normalised by the browser.
export function cycleHarmonics(v: EngineVoice) {
  const step = Math.round(60 / v.firingDiv);   // cycle harmonics per harmonic of f/2 (3 for a V6, 4 for a V8)
  const amps = new Float32Array(step * v.harmonics.length + 1);
  v.harmonics.forEach((a, k) => { amps[step * (k + 1)] += a; });
  for (const [order, a] of v.orders) amps[Math.round(order * 2)] += a;
  return amps;
}
function engineWave(ctx: BaseAudioContext, v: EngineVoice) {
  const im = cycleHarmonics(v);
  return ctx.createPeriodicWave(new Float32Array(im.length), im);
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

// A loop voice: its loops crossfaded by rpm (equal power: neighbouring loops are not in phase) and by throttle (in
// amplitude: a point's two loops share their firing times and play at the same rate, so they stay in phase), plus
// overrun pops and gear whine. Built once, the first time the voice is heard; silent while another car is driven.
class LoopPlayer {
  private readonly rpms: number[];
  private readonly src: AudioBufferSourceNode[] = [];
  private readonly mix: GainNode[] = [];
  private readonly out: GainNode;
  private readonly popF: BiquadFilterNode; private readonly pop: GainNode; private readonly popLow: GainNode;
  private readonly whineOsc: OscillatorNode; private readonly whine: GainNode;
  private onAt = -1e9;   // when the throttle was last open (pops come in a burst after a lift)

  constructor(ctx: BaseAudioContext, private readonly v: LoopVoice, loops: EngineLoop[], dest: AudioNode, bus: AudioNode,
    noise: AudioNode, mod: AudioNode, limPitch: AudioNode) {
    const gain = (g: number, to: AudioNode | AudioParam) => { const n = ctx.createGain(); n.gain.value = g; n.connect(to as AudioNode); return n; };
    const rough = gain(1, dest);
    mod.connect(gain(v.rough, rough.gain));
    this.out = gain(0, rough);
    this.rpms = loops.filter((_, k) => !(k & 1)).map((l) => l.rpm);
    for (const loop of loops) {
      const buf = ctx.createBuffer(1, loop.data.length, ctx.sampleRate); buf.copyToChannel(loop.data, 0);
      const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true;
      const g = gain(0, this.out); s.connect(g); limPitch.connect(s.detune);
      this.src.push(s); this.mix.push(g);
    }
    for (const s of this.src) s.start();   // together: each point's pair starts in phase

    // pops: short bursts of band-passed noise (crackle), some with a low thump
    this.pop = gain(0, bus); this.popLow = gain(0, bus);
    this.popF = ctx.createBiquadFilter(); this.popF.type = 'bandpass'; this.popF.Q.value = 0.8; this.popF.connect(this.pop);
    const low = ctx.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 280; low.connect(this.popLow);
    noise.connect(this.popF); noise.connect(low);
    // whine: a tone with a little second and third harmonic, its pitch wandering a few cents
    this.whine = gain(0, bus);
    this.whineOsc = ctx.createOscillator();
    this.whineOsc.setPeriodicWave(ctx.createPeriodicWave(new Float32Array([0, 0, 0, 0]), new Float32Array([0, 1, 0.3, 0.12])));
    this.whineOsc.connect(this.whine); mod.connect(gain(12, this.whineOsc.detune)); this.whineOsc.start();
  }

  // car: null while another voice plays. live: driving, and not just placed (no pops then).
  update(car: AudioCar | null, live: boolean, dt: number, t: number) {
    if (!car) { this.out.gain.setTargetAtTime(0, t, 0.02); this.whine.gain.setTargetAtTime(0, t, 0.02); return; }
    const v = this.v, rpms = this.rpms, thr = clamp(car.throttle, 0, 1), abs = Math.abs(car.speedF);
    const rpm = Math.max(car.rpm, car.spec.idle * 0.9);
    let i = 0; while (i < rpms.length - 2 && rpm > rpms[i + 1]) i++;
    const x = clamp(Math.log(rpm / rpms[i]) / Math.log(rpms[i + 1] / rpms[i]), 0, 1);
    for (let p = 0; p < rpms.length; p++) {
      const w = p === i ? Math.cos(x * Math.PI / 2) : p === i + 1 ? Math.sin(x * Math.PI / 2) : 0;
      const rate = rpm / rpms[p];
      this.src[2 * p].playbackRate.setTargetAtTime(rate, t, 0.012);
      this.src[2 * p + 1].playbackRate.setTargetAtTime(rate, t, 0.012);
      this.mix[2 * p].gain.setTargetAtTime(w * thr, t, 0.03);
      this.mix[2 * p + 1].gain.setTargetAtTime(w * (1 - thr), t, 0.03);
    }
    this.out.gain.setTargetAtTime(v.level, t, 0.03);

    // overrun pops: from 3,500 rpm up, in a burst for the first second or so after a lift, then now and then
    if (thr > 0.2) this.onAt = t;
    if (v.crackle > 0 && live && car.gear > 0 && thr < 0.05 && rpm > 3500) {
      const rate = 28 * clamp((rpm - 3500) / 3500, 0, 1) * (0.15 + 0.85 * Math.exp(-(t - this.onAt) / 0.9));   // per second
      const times: number[] = [];
      for (let k = Math.floor(rate * dt + Math.random()); k > 0; k--) times.push(t + Math.random() * dt);
      for (const tp of times.sort((a, b) => a - b)) {
        const a = v.crackle * (0.2 + 0.8 * Math.random() ** 2);
        this.popF.frequency.setValueAtTime(700 + 2800 * Math.random(), tp);
        this.pop.gain.setValueAtTime(a, tp); this.pop.gain.setTargetAtTime(0, tp + 0.001, 0.002 + 0.006 * Math.random());
        if (Math.random() < 0.35) { this.popLow.gain.setValueAtTime(a * 2.5, tp); this.popLow.gain.setTargetAtTime(0, tp + 0.002, 0.015); }
      }
    }
    // gear whine follows the road speed
    const [hz, level] = v.whine;
    this.whineOsc.frequency.setTargetAtTime(Math.max(20, abs * hz), t, 0.03);
    this.whine.gain.setTargetAtTime(level * clamp(abs / 50, 0, 1) * (0.6 + 0.4 * thr), t, 0.05);
  }
}
