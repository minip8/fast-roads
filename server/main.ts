import { listen } from './ws';

// ============================================================================
// `npm run server`: the multiplayer relay on WebSocket. PORT (default 8787) and HOST (default all interfaces)
// from the environment; MAX_PLAYERS (1-32, default 8) and BATCH_MS (0-100, default 0: relay car states at once;
// see RelayOptions.batchInterval) optionally. Logs rooms opening, joins, leaves and kicks.
// ============================================================================
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST || undefined;
const maxPlayers = process.env.MAX_PLAYERS ? Number(process.env.MAX_PLAYERS) : undefined;
const batchMs = Number(process.env.BATCH_MS ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`bad PORT ${process.env.PORT}`);
if (!(batchMs >= 0 && batchMs <= 100)) throw new Error(`bad BATCH_MS ${process.env.BATCH_MS}`);
if (maxPlayers !== undefined && !(Number.isInteger(maxPlayers) && maxPlayers >= 1 && maxPlayers <= 32)) throw new Error(`bad MAX_PLAYERS ${process.env.MAX_PLAYERS}`);

const stamp = () => new Date().toISOString();
const server = await listen({
  port, host,
  relay: { log: (line) => console.log(`${stamp()} ${line}`), batchInterval: batchMs / 1000, ...(maxPlayers ? { maxPlayers } : {}) },
});
console.log(`${stamp()} fast-roads relay listening on ${host ?? '*'}:${server.port}`);

const stop = () => { console.log(`${stamp()} shutting down`); server.close().then(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
