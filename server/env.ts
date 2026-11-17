import type { RelayOptions } from './relay';

// ============================================================================
// The relay settings both servers read from their environment (process.env for `npm run server`, the Worker's
// `vars` on Cloudflare), checked the same way: MAX_PLAYERS (1-32, default 8), BATCH_MS (0-100, default 0: relay
// car states at once; RelayOptions.batchInterval), MIN_LAP_SECS (1-600, default 40: the shortest lap the board
// takes). Throws on a bad value.
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
  if (maxPlayers !== undefined) out.maxPlayers = maxPlayers;
  if (batchMs !== undefined) out.batchInterval = batchMs / 1000;
  if (minLap !== undefined) out.minLapSecs = minLap;
  return out;
}
