// ============================================================================
// Multiplayer preferences and the room link, without the networking code (main.ts and menu.ts import this; src/net
// and the rest of multiplayer load only when a room is joined: netGame.ts).
// - The relay address: the menu's, else the build's VITE_RELAY_URL, else the page's host on the relay's default
//   port (8787, `npm run server`), ws:// (wss:// on an https page).
// - The room link: ?room=CODE (and &server=ws://... when not the default) joins that room on load.
// ============================================================================
export interface NetPrefs { server: string; room: string; name: string }
const KEY = 'fastroads.net';
export const RELAY_PORT = 8787;

export function defaultServer(): string {
  const env = import.meta.env.VITE_RELAY_URL as string | undefined;
  if (env) return env;
  const secure = typeof location !== 'undefined' && location.protocol === 'https:';
  const host = (typeof location !== 'undefined' && location.hostname) || 'localhost';
  return `${secure ? 'wss' : 'ws'}://${host.includes(':') ? `[${host}]` : host}:${RELAY_PORT}`;
}

export function loadNetPrefs(): NetPrefs {
  const d: NetPrefs = { server: '', room: '', name: '' };
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (v && typeof v === 'object') for (const k of ['server', 'room', 'name'] as const) {
      const x = (v as Record<string, unknown>)[k];
      if (typeof x === 'string') d[k] = x.slice(0, 200);
    }
  } catch { /* storage unavailable or corrupt */ }
  return d;
}
export function saveNetPrefs(p: NetPrefs) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage unavailable */ } }

export const cleanRoom = (room: string) => room.trim().toUpperCase();
export const validRoom = (room: string) => /^[A-Z0-9]{1,8}$/.test(room);
export const validServer = (url: string) => /^wss?:\/\/[^\s/]+/i.test(url.trim());

// A room from the page's address (?room=, &server=), or null.
export function roomFromUrl(params: URLSearchParams): { room: string; server: string } | null {
  const room = cleanRoom(params.get('room') ?? '');
  if (!validRoom(room)) return null;
  const server = params.get('server')?.trim();
  return { room, server: server && validServer(server) ? server : '' };
}

// Puts the room in the page's address (so it can be shared and a reload rejoins), or takes it out (null).
export function roomUrl(room: string | null, server = ''): string {
  const u = new URL(location.href);
  u.searchParams.delete('room'); u.searchParams.delete('server');
  if (room) {
    u.searchParams.set('room', room);
    if (server && server !== defaultServer()) u.searchParams.set('server', server);
  }
  return u.toString();
}

// A name for a player who has not chosen one.
export const randomName = () => `Driver ${100 + Math.floor(Math.random() * 900)}`;
