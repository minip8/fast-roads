// ============================================================================
// Engine loops: a piston engine's exhaust sound, synthesised into seamless loop buffers that SoundGraph plays the
// way sample-based racing sims play recordings (one loop per rpm point and load, crossfaded, playbackRate
// following rpm). Plain JS, no Web Audio, so it runs (and is tested) in Node.
//
// Per firing: an exhaust blowdown pulse (fast rise, decay over part of the firing interval) with combustion noise
// riding on it, into its bank's pipe (a waveguide: the pulse reflects inverted from the open end, which gives the
// pipe its resonances). A cross-plane V8's banks each fire unevenly (90-180-270 degree gaps), so each bank's pulse
// train holds half orders of the crank that the two banks together cancel; with side exits the banks reach the
// listener at different distances and levels, so some of them stay. Fixed differences between cylinders and
// random cycle-to-cycle variation (much more on the overrun) add the lump. Then the radiated sound (pressure plus
// its rate of change), saturation (the bark) and a lowpass, both harder on load, with a low resonance of the
// exhaust and body between them (the weight, fullest on the overrun).
// Everything is periodic over the loop: pulses and noise wrap around, and the filters run over the loop twice so
// only their steady state is kept.
// ============================================================================

export interface LoopVoice {
  firing: number[];            // bank (0 or 1) of each cylinder in firing order; firings are evenly spaced in crank angle
  rpms: number[];              // the loops' rpm points, rising (each loop's exact rpm is within a few rpm of these)
  pipes: [number, number];     // m: exhaust length per bank
  exitGap: number;             // m: how much further the second bank's exit is from the listener
  body: [hz: number, q: number, dbCoast: number, dbLoad: number];   // low resonance of the exhaust and body (the weight)
  level: number;               // gain of the loops into the engine chain (they are all at LOOP_RMS)
  rough: number;               // slow random level wobble on top of the loops, 0..1
  crackle: number;             // overrun pop level (0: none)
  whine: [hzPerMs: number, level: number];   // straight-cut gear whine: pitch per m/s of road speed, level (0: none)
}

export interface EngineLoop {
  data: Float32Array<ArrayBuffer>;   // mono, at the sample rate it was made for; loops seamlessly
  rpm: number;                 // the exact rpm it was made at (play at rate = rpm / this)
  cycles: number;              // engine cycles (two crank turns) in the loop
}

const LOOP_SECONDS = 1.1;      // long enough that the cycle-to-cycle variation does not audibly repeat
const SOUND_SPEED = 520;       // m/s in the hot exhaust
const AIR_SPEED = 343;         // m/s outside
const RADIATE_HZ = 1600;       // radiated sound: the pressure and its rate of change weigh the same here
export const LOOP_RMS = 0.2;   // every loop is normalised to this level (the graph sets the loudness)

// What changes between overrun (0) and full throttle (1).
const LOAD = {
  pulse: [0.3, 1],             // blowdown pulse height
  rise: [0.5e-3, 0.16e-3],     // s: pulse rise time (a big charge blows down hard)
  decay: [0.22, 0.32],         // pulse decay, in firing intervals
  jitter: [0.3, 0.06],         // random pulse height variation per firing (the overrun burble)
  noise: [0.12, 0.2],          // combustion / flow noise riding on the pulses
  bright: [1000, 2800],        // Hz: radiated lowpass
  drive: [0.5, 1.3],           // saturation
  reflect: [0.4, 0.45],        // pipe end reflection
} as const;
const BANK_GAIN = 0.6;         // the far bank's level at the listener

// Seeded random (mulberry32): the same loops on every run.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const lerp = (pair: readonly [number, number], load: number) => pair[0] + (pair[1] - pair[0]) * load;

// One loop at about `rpm`, at load 0 (overrun) to 1 (full throttle). Loops made with the same seed at the same rpm
// share their firing times, so the graph can crossfade them in phase.
export function engineLoop(v: LoopVoice, sr: number, rpm: number, load: number, seed = 1): EngineLoop {
  const cyl = v.firing.length;
  const cycle = Math.round(sr * 120 / rpm);                  // samples per engine cycle, whole: the loop is exact
  const cycles = Math.max(1, Math.round(sr * LOOP_SECONDS / cycle));
  const n = cycle * cycles, interval = cycle / cyl;

  // Excitation per bank: pulses, and the envelope the combustion noise follows.
  const exc = [new Float32Array(n), new Float32Array(n)], env = [new Float32Array(n), new Float32Array(n)];
  const timing = rng(seed), height = rng(seed * 7 + 3);
  // fixed per-cylinder differences (breathing, runner length): +-15% height, +-1.5 crank degrees
  const cylGain = v.firing.map(() => 1 + 0.3 * (timing() - 0.5));
  const cylShift = v.firing.map(() => (timing() - 0.5) * 3 / 720 * cycle);
  const tr = lerp(LOAD.rise, load) * sr, td = lerp(LOAD.decay, load) * interval;
  const span = Math.ceil(tr * 4 + td * 7), m1 = Math.exp(-1 / tr), m2 = Math.exp(-1 / td);
  const amp = lerp(LOAD.pulse, load), jit = lerp(LOAD.jitter, load) * (1 + 2000 / rpm) * 0.5;   // more at low rpm
  for (let c = 0; c < cycles; c++) {
    for (let k = 0; k < cyl; k++) {
      const t0 = c * cycle + k * interval + cylShift[k] + (timing() - 0.5) * 0.004 * interval;
      const a = amp * cylGain[k] * Math.max(0.05, 1 + jit * (height() + height() - 1));
      const e = exc[v.firing[k]], en = env[v.firing[k]];
      const i0 = Math.ceil(t0);
      let r = Math.exp((t0 - i0) / tr), d = a * Math.exp((t0 - i0) / td), j = i0 % n;
      for (let i = 0; i < span; i++) {   // a (1 - exp(-tau / tr)) exp(-tau / td), by recurrence
        const p = d * (1 - r);
        e[j] += p; en[j] += p;
        r *= m1; d *= m2; if (++j === n) j = 0;
      }
    }
  }
  const noiseAmp = lerp(LOAD.noise, load);
  let ns = (seed * 2654435761) >>> 0 || 1;
  for (let b = 0; b < 2; b++) {
    const e = exc[b], en = env[b];
    let prev = 0;
    for (let i = 0; i < n; i++) {   // xorshift white noise, differenced: hiss rather than rumble
      ns ^= ns << 13; ns ^= ns >>> 17; ns ^= ns << 5;
      const w = (ns >>> 0) / 2147483648 - 1;
      e[i] += noiseAmp * en[i] * (w - 0.6 * prev); prev = w;
    }
  }

  // Each bank's pipe, then to the listener: the second bank's exit is further away.
  const out = new Float32Array(n), gap = v.exitGap / AIR_SPEED * sr;
  for (let b = 0; b < 2; b++) {
    const y = pipe(exc[b], 2 * v.pipes[b] / SOUND_SPEED * sr, lerp(LOAD.reflect, load));
    const g = b ? BANK_GAIN : 1, delay = b ? gap : 0, d0 = Math.floor(delay), fr = delay - d0;
    for (let i = 0, ja = (n - d0) % n, jz = (n - d0 - 1) % n; i < n; i++) {
      out[i] += g * (y[ja] + (y[jz] - y[ja]) * fr);
      if (++ja === n) ja = 0; if (++jz === n) jz = 0;
    }
  }

  // Radiated: the pressure (the low burble) plus its rate of change (the edge of each pulse).
  const dk = sr / (2 * Math.PI * RADIATE_HZ);
  for (let i = 0, prev = out[n - 1]; i < n; i++) { const x = out[i]; out[i] = x + dk * (x - prev); prev = x; }
  highpass(out, sr, 25);

  // Saturation from unit RMS, harder on load (rasp), then the lowpass (which also takes off what the saturation
  // adds up high) and the common level.
  scale(out, 1 / rmsOf(out));
  const drive = lerp(LOAD.drive, load), norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) out[i] = Math.tanh(drive * out[i]) / norm;
  peaking(out, sr, v.body[0], v.body[1], v.body[2] + (v.body[3] - v.body[2]) * load);
  const bright = lerp(LOAD.bright, load);
  lowpass(out, sr, bright); lowpass(out, sr, bright * 2.5); highpass(out, sr, 20);
  scale(out, LOOP_RMS / rmsOf(out));
  let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0.98) scale(out, 0.98 / peak);
  return { data: out, rpm: 120 * sr / cycle, cycles };
}

// The loops a voice plays, in order: point k's on-load loop is number 2k, its overrun loop 2k + 1.
export const loopCount = (v: LoopVoice) => v.rpms.length * 2;
export const makeLoop = (v: LoopVoice, sr: number, k: number) => engineLoop(v, sr, v.rpms[k >> 1], k & 1 ? 0 : 1, (k >> 1) + 1);

// A pipe as a waveguide: what goes in comes back after the round trip `delay` (samples, fractional), inverted by
// the open end, a little duller and weaker each time. Run over the periodic input twice; the second pass is kept.
function pipe(x: Float32Array, delay: number, reflect: number) {
  const n = x.length, y = new Float32Array(n), d0 = Math.floor(delay), fr = delay - d0;
  let lp = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0, ja = n - d0, jb = n - d0 - 1; i < n; i++) {
      lp += 0.55 * (y[ja] + (y[jb] - y[ja]) * fr - lp);
      y[i] = x[i] - reflect * lp;
      if (++ja === n) ja = 0; if (++jb === n) jb = 0;
    }
  }
  return y;
}

// One-pole filters (the lowpass two in a row), warmed up on one pass over the loop so they start in steady state.
function lowpass(x: Float32Array, sr: number, hz: number) {
  const k = 1 - Math.exp(-2 * Math.PI * hz / sr);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) { s1 += k * (x[i] - s1); s2 += k * (s1 - s2); }
  for (let i = 0; i < x.length; i++) { s1 += k * (x[i] - s1); s2 += k * (s1 - s2); x[i] = s2; }
}
// Peaking EQ (RBJ cookbook, as Web Audio's 'peaking' biquad), run twice over the loop like the others.
function peaking(x: Float32Array, sr: number, hz: number, q: number, db: number) {
  const A = 10 ** (db / 40), w = 2 * Math.PI * hz / sr, al = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + al / A;
  const b0 = (1 + al * A) / a0, b1 = -2 * c / a0, b2 = (1 - al * A) / a0, a1 = -2 * c / a0, a2 = (1 - al / A) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < x.length; i++) {
      const x0 = x[i], y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
      if (pass) x[i] = y0;
    }
  }
}
function highpass(x: Float32Array, sr: number, hz: number) {
  const k = 1 - Math.exp(-2 * Math.PI * hz / sr);
  let s = 0;
  for (let i = 0; i < x.length; i++) s += k * (x[i] - s);
  for (let i = 0; i < x.length; i++) { s += k * (x[i] - s); x[i] -= s; }
}
function rmsOf(x: Float32Array) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / x.length) || 1; }
function scale(x: Float32Array, k: number) { for (let i = 0; i < x.length; i++) x[i] *= k; }
