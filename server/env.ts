import { RELAY_DEFAULTS, type RelayOptions } from './relay';

// ============================================================================
// The relay settings both servers read from their environment (process.env for `npm run server`, the Worker's
// `vars` on Cloudflare), checked the same way: MAX_PLAYERS (1-32, default 8), BATCH_MS (0-100, default 0: relay
// car states at once; RelayOptions.batchInterval), MIN_LAP_SECS (1-600, default 40: the shortest lap the board
// takes), WEEKEND_SCALE (0.001-1, default 1: every race-weekend duration, from a settings minute to the host's
// grace, multiplied by it; for tests, which cannot wait for real sessions). Throws on a bad value.
// ============================================================================
export function relayEnv(env: Record<string, unknown>): Partial<Omit<RelayOptions, 'now'>> {
  const num = (k: string, lo: number, hi: number, int: boolean): number | undefined => {
    const raw = env[k];
    if (raw === undefined || raw === '') return undefined;
    const v = Number(raw);
    if (!(v >= lo && v <= hi) || (int && !Number.isInteger(v))) throw new Error(`bad ${k} ${String(raw)}`);
    return v;
  };
  const out: Partial<Omit<RelayOptions, 'now'>> = {};
  const maxPlayers = num('MAX_PLAYERS', 1, 32, true), batchMs = num('BATCH_MS', 0, 100, false), minLap = num('MIN_LAP_SECS', 1, 600, false);
  const scale = num('WEEKEND_SCALE', 0.001, 1, false);
  if (maxPlayers !== undefined) out.maxPlayers = maxPlayers;
  if (batchMs !== undefined) out.batchInterval = batchMs / 1000;
  if (minLap !== undefined) out.minLapSecs = minLap;
  if (scale !== undefined) Object.assign(out, scaledWeekend(scale));
  return out;
}

// The race-weekend durations of RELAY_DEFAULTS times `k` (the start lights stay a second apart: that is the protocol).
export function scaledWeekend(k: number): Partial<RelayOptions> {
  const d = RELAY_DEFAULTS;
  return {
    minute: d.minute * k, gridSecs: d.gridSecs * k, lightsHold: [d.lightsHold[0] * k, d.lightsHold[1] * k], resultsSecs: d.resultsSecs * k,
    overtimeSecs: d.overtimeSecs * k, oneShotPrep: d.oneShotPrep * k, oneShotLimit: d.oneShotLimit * k, maxRaceLapSecs: d.maxRaceLapSecs * k,
    hostGrace: d.hostGrace * k, pitSpacing: d.pitSpacing * k,
  };
}
