import { relayEnv } from './env';
import { listen } from './ws';

// ============================================================================
// `npm run server`: the multiplayer relay on WebSocket. PORT (default 8787) and HOST (default all interfaces)
// from the environment; MAX_PLAYERS, BATCH_MS and MIN_LAP_SECS optionally (server/env.ts). Logs rooms opening,
// joins, leaves and kicks.
// ============================================================================
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST || undefined;
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`bad PORT ${process.env.PORT}`);
const options = relayEnv(process.env);

const stamp = () => new Date().toISOString();
const server = await listen({
  port, host,
  relay: { log: (line) => console.log(`${stamp()} ${line}`), ...options },
});
console.log(`${stamp()} fast-roads relay listening on ${host ?? '*'}:${server.port}`);

const stop = () => { console.log(`${stamp()} shutting down`); server.close().then(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
