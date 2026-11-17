// ============================================================================
// Multiplayer preferences and the room link, without the networking code (main.ts and menu.ts import this; src/net
// and the rest of multiplayer load only when a room is joined: netGame.ts).
// - The relay address: the menu's, else the build's VITE_RELAY_URL, else the page's host on the relay's default
//   port (8787, `npm run server`), ws:// (wss:// on an https page).
// - The room link: ?room=CODE (and &server=ws://... when not the default) joins that room on load.
// - Room codes the game makes (newRoomCode), and what the Join field takes (parseInvite: a code or a whole link).
// - The seat: the room, relay and rejoin token of this tab (sessionStorage), so a reload or a circuit change comes
//   back as the same player, host role and race entry included.
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

// ---------------------------------------------------------------------------- room codes
// The letters and digits a made code uses: none that read as another (0 O Q, 1 I L, 2 Z, 5 S, 8 B, U V), so a code
// read out or copied by hand comes out right. 4 of these 21: 194,481 codes.
export const CODE_ALPHABET = 'ACDEFGHJKMNPRTWXY3467';
export const CODE_LENGTH = 4;
export function newRoomCode(random: () => number = Math.random): string {
  let s = '';
  for (let k = 0; k < CODE_LENGTH; k++) s += CODE_ALPHABET[Math.min(CODE_ALPHABET.length - 1, Math.floor(random() * CODE_ALPHABET.length))];
  return s;
}

// What the Join field was given: a room code (spaces and dashes ignored, any case) or an invite link (?room=CODE,
// and &server= if it names a relay). null: neither.
export function parseInvite(text: string): { room: string; server: string } | null {
  const t = text.trim();
  if (!t) return null;
  if (/[?&]room=/i.test(t) || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    let u: URL;
    try { u = new URL(t, 'https://invite.invalid/'); } catch { return null; }
    const params = new URLSearchParams([...u.searchParams].map(([k, v]) => [k.toLowerCase(), v]));
    return roomFromUrl(params);
  }
  const room = cleanRoom(t.replace(/[\s-]+/g, ''));
  return validRoom(room) ? { room, server: '' } : null;
}

// A room from the page's address (?room=, &server=), or null.
export function roomFromUrl(params: URLSearchParams): { room: string; server: string } | null {
  const room = cleanRoom(params.get('room') ?? '');
  if (!validRoom(room)) return null;
  const server = params.get('server')?.trim();
  return { room, server: server && validServer(server) ? server : '' };
}

// Puts the room in the page's address (so a reload rejoins), or takes it out (null). Other parameters are kept.
export function roomUrl(room: string | null, server = ''): string {
  const u = new URL(location.href);
  u.searchParams.delete('room'); u.searchParams.delete('server');
  if (room) {
    u.searchParams.set('room', room);
    if (server && server !== defaultServer()) u.searchParams.set('server', server);
  }
  return u.toString();
}

// The link to send others: this page with only the room (and the relay, if not the default) in it.
export function inviteUrl(room: string, server = '', page: string = location.href): string {
  const u = new URL(page);
  u.search = ''; u.hash = '';
  u.searchParams.set('room', room);
  if (server && server !== defaultServer()) u.searchParams.set('server', server);
  return u.toString();
}

// ---------------------------------------------------------------------------- the seat (rejoin token)
export interface Seat { room: string; server: string; token: number }
type SeatStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const SEAT_KEY = 'fastroads.seat';
const tabStore = (): SeatStore | null => { try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch { return null; } };

// The token for this room on this relay, if this tab has one.
export function loadSeat(room: string, server: string, store = tabStore()): number | null {
  try {
    const v: unknown = JSON.parse(store?.getItem(SEAT_KEY) ?? 'null');
    if (!v || typeof v !== 'object') return null;
    const s = v as Partial<Seat>;
    const ok = s.room === room && s.server === server && Number.isInteger(s.token) && s.token! > 0 && s.token! <= 0xffffffff;
    return ok ? s.token! : null;
  } catch { return null; }
}
export function saveSeat(seat: Seat, store = tabStore()) {
  if (!validRoom(seat.room) || !(seat.token > 0)) return;
  try { store?.setItem(SEAT_KEY, JSON.stringify(seat)); } catch { /* storage unavailable */ }
}
export function clearSeat(store = tabStore()) { try { store?.removeItem(SEAT_KEY); } catch { /* storage unavailable */ } }

// A name for a player who has not chosen one.
export const randomName = () => `Driver ${100 + Math.floor(Math.random() * 900)}`;
