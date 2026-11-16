import { DEFAULT_CONFIG, type EnvConfig } from './config';
import { END_REASONS, INFO_FIELDS, PHYSICS_HZ, TRACK_IDS } from './env';
import { CAR_IDS, OBS_CLIP, OBS_VERSION, type ObsEntry } from './observation';
import type { VecEnv } from './vec';

// ============================================================================
// The worker's wire protocol (docs/ai-env.md is the reference): length-prefixed frames, little-endian. Every frame
// is u32 payload length, then the payload: an 8-byte header (u8 type, 3 zero bytes, u32 argument), then the body.
// Binary bodies keep every array at an offset that is a multiple of its element size (float64 blocks at multiples
// of 8), so a client can view them in place. Pure byte handling: the Node worker (ai/worker.ts) does the I/O.
// ============================================================================
export const PROTOCOL_VERSION = 1;
export const HEADER = 8;

export const MSG = {
  hello: 0x01,      // worker -> client, on start: JSON
  init: 0x02,       // client -> worker: JSON { numEnvs, seed?, config? }
  ready: 0x03,      // worker -> client: JSON (the specs for that config)
  reset: 0x10,      // client -> worker: JSON reset options (object for all, array per env, or empty)
  resetOk: 0x11,    // worker -> client: binary
  step: 0x20,       // client -> worker: binary, arg = N, body f32[N x 2]
  stepOk: 0x21,     // worker -> client: binary
  error: 0x7e,      // worker -> client: JSON { error }
  close: 0x7f,      // client -> worker: the worker exits
} as const;

export interface GameBuild { commit: string; dirty: boolean; builtAt: string }

export const ACTION_SPEC = [
  { name: 'steer', index: 0, low: -1, high: 1, desc: 'absolute mode: steering command as a share of the car\'s full road-wheel lock, + = left; delta mode: change of that command per step, x deltaScale[0]' },
  { name: 'pedal', index: 1, low: -1, high: 1, desc: 'absolute mode: + throttle, - brake (one pedal at a time); delta mode: change per step, x deltaScale[1]' },
];

export function helloJson(build: GameBuild) {
  return {
    protocol: PROTOCOL_VERSION, game: build, physicsHz: PHYSICS_HZ,
    tracks: TRACK_IDS, cars: CAR_IDS, defaultConfig: DEFAULT_CONFIG,
    infoFields: INFO_FIELDS, endReasons: END_REASONS, obsVersion: OBS_VERSION,
  };
}

export function readyJson(vec: VecEnv, cfg: EnvConfig, spec: ObsEntry[], seed: number) {
  return {
    protocol: PROTOCOL_VERSION, numEnvs: vec.n, seed, config: cfg,
    obsSize: vec.obsSize, obsVersion: OBS_VERSION, obsClip: OBS_CLIP, obsSpec: spec,
    actionSize: 2, actionSpec: ACTION_SPEC,
    infoFields: INFO_FIELDS, endReasons: END_REASONS,
  };
}

const enc = new TextEncoder(), dec = new TextDecoder();
const pad8 = (n: number) => (n + 7) & ~7;

// A whole frame (length prefix included) around a JSON body.
export function jsonFrame(type: number, value: unknown): Uint8Array {
  const body = enc.encode(JSON.stringify(value));
  const out = new Uint8Array(4 + HEADER + body.length), v = new DataView(out.buffer);
  v.setUint32(0, HEADER + body.length, true);
  v.setUint8(4, type);
  v.setUint32(8, body.length, true);
  out.set(body, 4 + HEADER);
  return out;
}
export function parseJsonBody(payload: Uint8Array): unknown {
  const text = dec.decode(payload.subarray(HEADER));
  return text.trim() ? JSON.parse(text) : {};
}

// A frame of `size` payload bytes: the payload starts 8 bytes into the buffer (so its float64 blocks can be viewed
// in place), with the length prefix in the 4 bytes before it; the frame is the buffer from byte 4.
function frameBuffer(size: number): ArrayBuffer {
  const buf = new ArrayBuffer(8 + size);
  new DataView(buf).setUint32(4, size, true);
  return buf;
}

// RESET_OK: header arg N; body u32 N, u32 D, u32 F, u32 0, then obs f32[N*D] (padded to 8), info f64[N*F].
export function resetOkFrame(vec: VecEnv): Uint8Array {
  const N = vec.n, D = vec.obsSize, F = vec.infoSize;
  const oObs = HEADER + 16, oInfo = pad8(oObs + 4 * N * D), size = oInfo + 8 * N * F;
  const buf = frameBuffer(size), v = new DataView(buf, 8), b = 8;
  v.setUint8(0, MSG.resetOk); v.setUint32(4, N, true);
  v.setUint32(HEADER, N, true); v.setUint32(HEADER + 4, D, true); v.setUint32(HEADER + 8, F, true);
  new Float32Array(buf, b + oObs, N * D).set(vec.obs);
  new Float64Array(buf, b + oInfo, N * F).set(vec.info);
  return new Uint8Array(buf, 4);
}

// STEP_OK: header arg N; body u32 N, u32 D, u32 F, u32 K (environments whose episode ended), then
// obs f32[N*D] | reward f32[N] | terminated u8[N] | truncated u8[N] | pad to 8 | info f64[N*F] |
// done u32[K] | pad to 8 | final obs f32[K*D]
export function stepOkFrame(vec: VecEnv): Uint8Array {
  const N = vec.n, D = vec.obsSize, F = vec.infoSize, K = vec.done.length;
  const oObs = HEADER + 16, oRew = oObs + 4 * N * D, oTerm = oRew + 4 * N, oTrunc = oTerm + N;
  const oInfo = pad8(oTrunc + N), oDone = oInfo + 8 * N * F, oFinal = pad8(oDone + 4 * K), size = oFinal + 4 * K * D;
  const buf = frameBuffer(size), v = new DataView(buf, 8), b = 8;
  v.setUint8(0, MSG.stepOk); v.setUint32(4, N, true);
  v.setUint32(HEADER, N, true); v.setUint32(HEADER + 4, D, true); v.setUint32(HEADER + 8, F, true); v.setUint32(HEADER + 12, K, true);
  new Float32Array(buf, b + oObs, N * D).set(vec.obs);
  new Float32Array(buf, b + oRew, N).set(vec.reward);
  new Uint8Array(buf, b + oTerm, N).set(vec.terminated);
  new Uint8Array(buf, b + oTrunc, N).set(vec.truncated);
  new Float64Array(buf, b + oInfo, N * F).set(vec.info);
  const done = new Uint32Array(buf, b + oDone, K), fin = new Float32Array(buf, b + oFinal, K * D);
  vec.done.forEach((k, j) => { done[j] = k; fin.set(vec.finalObs.subarray(k * D, (k + 1) * D), j * D); });
  return new Uint8Array(buf, 4);
}

// Splits complete frames off the front of a byte stream: returns the payloads and the bytes left over.
export function splitFrames(buf: Uint8Array): { frames: Uint8Array[]; rest: Uint8Array } {
  const frames: Uint8Array[] = [];
  let at = 0;
  while (buf.length - at >= 4) {
    const len = new DataView(buf.buffer, buf.byteOffset + at, 4).getUint32(0, true);
    if (buf.length - at - 4 < len) break;
    frames.push(buf.subarray(at + 4, at + 4 + len));
    at += 4 + len;
  }
  return { frames, rest: buf.subarray(at) };
}
