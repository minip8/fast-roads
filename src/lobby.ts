import { CARS, type CarId } from './cars';
import {
  type BoardEntry, CAR_REASON, emptySample, ERROR, GRID_ORDERS, INVALID_PENALTIES, NET_CARS, type NetClient, type NetEvent, normaliseSettings,
  type Phase, QUALIFYING, type RemoteSample, type RoomSettings, type SessionInfo, SETTING_RANGES, type Standing, STATE_FLAG, TYRE_WEAR,
  WEATHER_KINDS,
} from './net';
import { fmtTime } from './util';

export { normaliseSettings } from './net';

// ============================================================================
// What the menu shows of a multiplayer room, without the DOM: the weekend settings as menu controls (built from
// src/net/race.ts's lists and ranges, so they cannot drift from what the relay takes), presets, the plain-words
// lines about the session under way, the results tables, the players' states, and RoomLog (what the menu keeps of
// the room between events: the last qualifying's times). Loaded with netGame.ts (only in a room, so a
// single-player page never downloads src/net); menu.ts reads it through MenuHost.net.room().
// ============================================================================
export type RoomKey = Exclude<keyof RoomSettings, 'circuit'>;
export type RoomValue = RoomSettings[RoomKey];
export type FieldGroup = 'sessions' | 'rules' | 'cars';
export const FIELD_GROUPS: [FieldGroup, string][] = [['sessions', 'Sessions'], ['rules', 'Race rules'], ['cars', 'Cars and weather']];

export interface RoomField {
  key: RoomKey;
  label: string;
  hint: string;                                        // one line of plain words
  group: FieldGroup;
  kind: 'choice' | 'step';                             // buttons, or − value + through `options`
  options: readonly (readonly [RoomValue, string])[];
  applies?: (s: RoomSettings) => boolean;              // false: it has no effect as the other settings are (dimmed)
  allowed?: (v: RoomValue, s: RoomSettings) => boolean;   // an option that cannot be chosen as the others are
  format?: (v: number) => string;                      // steppers: a value as text (also one between the options)
}
const stepper = (vals: number[], range: readonly [number, number], format: (v: number) => string) =>
  ({ kind: 'step' as const, format, options: within(vals, range).map((v) => [v, format(v)] as const) });
const mins = (v: number) => `${v} min`;

const within = (vals: number[], [lo, hi]: readonly [number, number]) => vals.filter((v) => v >= lo && v <= hi);
const MINUTES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 45, 50, 60, 75, 90, 105, 120];
const LAPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 99];
const FINISH_SECS = [30, 45, 60, 90, 120, 180, 240, 300, 420, 600];
const n = (v: number, one: string, many = one + 's') => `${v} ${v === 1 ? one : many}`;
export const fmtSecs = (s: number) => (s < 120 ? `${s} s` : `${Math.round(s / 6) / 10} min`);
const QUALIFYING_TEXT: Record<RoomSettings['qualifying'], string> = { none: 'None', timed: 'Timed', oneShot: 'One shot' };
const GRID_TEXT: Record<RoomSettings['grid'], string> = { qualifying: 'Qualifying', random: 'Random', reversed: 'Reversed', joinOrder: 'Join order' };
const WEATHER_TEXT: Record<RoomSettings['weather'], string> = { dry: 'Dry', damp: 'Damp', wet: 'Wet', changeable: 'Changeable', random: 'Random' };
const carName = (id: string) => (id in CARS ? CARS[id as CarId].name : id);

export const ROOM_FIELDS: readonly RoomField[] = [
  { key: 'practice', label: 'Practice sessions', group: 'sessions', kind: 'choice',
    hint: 'Free running first, to learn the circuit and try the tyres.',
    options: within([0, 1, 2, 3], SETTING_RANGES.practice).map((v) => [v, v ? String(v) : 'None'] as const) },
  { key: 'practiceMinutes', label: 'Practice length', group: 'sessions', hint: 'Each practice session.',
    ...stepper(MINUTES, SETTING_RANGES.practiceMinutes, mins), applies: (s) => s.practice > 0 },
  { key: 'qualifying', label: 'Qualifying', group: 'sessions', kind: 'choice',
    hint: 'Timed: your best lap in the time sets the grid. One shot: a single flying lap each, no traffic.',
    options: QUALIFYING.map((v) => [v, QUALIFYING_TEXT[v]] as const) },
  { key: 'qualifyingMinutes', label: 'Qualifying length', group: 'sessions',
    hint: 'Timed qualifying. A lap begun before the flag still counts.',
    ...stepper(MINUTES, SETTING_RANGES.qualifyingMinutes, mins), applies: (s) => s.qualifying === 'timed' },
  { key: 'raceLaps', label: 'Race length', group: 'sessions', hint: 'Laps from the lights going out.',
    ...stepper(LAPS, SETTING_RANGES.raceLaps, (v) => n(v, 'lap')) },
  { key: 'grid', label: 'Starting grid', group: 'sessions', kind: 'choice',
    hint: 'Who starts where. Qualifying and reversed need a qualifying session.',
    options: GRID_ORDERS.map((v) => [v, GRID_TEXT[v]] as const),
    allowed: (v, s) => s.qualifying !== 'none' || (v !== 'qualifying' && v !== 'reversed') },
  { key: 'pitStops', label: 'Mandatory pit stops', group: 'rules', kind: 'choice',
    hint: 'Stops every car must make in the race. A missed one costs 60 s.',
    options: within([0, 1, 2, 3], SETTING_RANGES.pitStops).map((v) => [v, v ? String(v) : 'None'] as const) },
  { key: 'tyreWear', label: 'Tyre wear', group: 'rules', kind: 'choice', hint: '×1 is normal. Higher wears the tyres out sooner, so stops matter.',
    options: TYRE_WEAR.map((v) => [v, `×${v}`] as const) },
  { key: 'collisions', label: 'Collisions in the race', group: 'rules', kind: 'choice',
    hint: 'Off: cars pass through each other. Practice and timed qualifying always collide.',
    options: [[true, 'On'], [false, 'Off']] },
  { key: 'invalidPenalty', label: 'Track limits penalty', group: 'rules', kind: 'choice', hint: 'Added to your race time for each lap cut off the track.',
    options: INVALID_PENALTIES.map((v) => [v, v ? `${v} s` : 'None'] as const) },
  { key: 'finishSecs', label: 'Time to finish', group: 'rules', hint: 'How long the others have after the winner crosses the line.',
    ...stepper(FINISH_SECS, SETTING_RANGES.finishSecs, fmtSecs) },
  { key: 'car', label: 'Allowed cars', group: 'cars', kind: 'choice', hint: 'Any car, or everyone in the same one.',
    options: [['', 'Any'], ...NET_CARS.map((id) => [id, carName(id)] as const)] },
  { key: 'weather', label: 'Weather', group: 'cars', kind: 'choice',
    hint: 'Damp and wet start with water on the track, changeable brings showers, random picks one.',
    options: WEATHER_KINDS.map((v) => [v, WEATHER_TEXT[v]] as const) },
];

// The option shown for a value (a value between the options, which the relay can hold, shows as itself).
export function optionLabel(f: RoomField, v: RoomValue): string {
  return f.options.find(([o]) => o === v)?.[1] ?? (f.format && typeof v === 'number' ? f.format(v) : String(v));
}
// The next option from v in direction dir, skipping options not allowed: round from the last to the first with
// `wrap` (buttons), else stopping at the ends (steppers); v itself if there is none.
export function stepOption(f: RoomField, v: RoomValue, dir: number, s: RoomSettings, wrap = false): RoomValue {
  const ok = f.options.filter(([o]) => !f.allowed || f.allowed(o, s)).map(([o]) => o);
  const k = ok.indexOf(v);
  if (k >= 0) return ok[wrap ? (((k + dir) % ok.length) + ok.length) % ok.length : Math.max(0, Math.min(ok.length - 1, k + dir))];
  if (typeof v === 'number') {   // between options: the nearest one that way
    const nums = ok as number[];
    const next = dir > 0 ? nums.find((o) => o > v) : [...nums].reverse().find((o) => o < v);
    return next ?? v;
  }
  return ok[0] ?? v;
}

// ---------------------------------------------------------------------------- presets
export interface Preset { id: string; name: string; blurb: string; settings: Omit<RoomSettings, 'circuit' | 'car'> }
export const PRESETS: readonly Preset[] = [
  { id: 'quick', name: 'Quick race', blurb: 'Straight to a random grid, 5 laps.',
    settings: { practice: 0, practiceMinutes: 10, qualifying: 'none', qualifyingMinutes: 10, raceLaps: 5, grid: 'random', pitStops: 0,
      tyreWear: 1, weather: 'dry', collisions: true, invalidPenalty: 0, finishSecs: 120 } },
  { id: 'short', name: 'Short weekend', blurb: '10 min practice, 10 min qualifying, 5 laps.',
    settings: { practice: 1, practiceMinutes: 10, qualifying: 'timed', qualifyingMinutes: 10, raceLaps: 5, grid: 'qualifying', pitStops: 0,
      tyreWear: 1, weather: 'dry', collisions: true, invalidPenalty: 0, finishSecs: 120 } },
  { id: 'full', name: 'Full weekend', blurb: 'Two practices, 15 min qualifying, 20 laps with a pit stop, any weather.',
    settings: { practice: 2, practiceMinutes: 15, qualifying: 'timed', qualifyingMinutes: 15, raceLaps: 20, grid: 'qualifying', pitStops: 1,
      tyreWear: 2, weather: 'random', collisions: true, invalidPenalty: 5, finishSecs: 180 } },
];
// The preset the settings are (circuit and car aside), or null: custom.
export function presetOf(s: RoomSettings): Preset | null {
  return PRESETS.find((p) => (Object.keys(p.settings) as (keyof Preset['settings'])[]).every((k) => p.settings[k] === s[k])) ?? null;
}
export const withPreset = (s: RoomSettings, p: Preset): RoomSettings => normaliseSettings({ ...s, ...p.settings });

// One line: what the weekend is.
export function weekendSummary(s: RoomSettings): string {
  const parts: string[] = [];
  if (s.practice) parts.push(`${s.practice > 1 ? `${s.practice} × ` : ''}${s.practiceMinutes} min practice`);
  if (s.qualifying === 'timed') parts.push(`${s.qualifyingMinutes} min qualifying`);
  else if (s.qualifying === 'oneShot') parts.push('one-shot qualifying');
  parts.push(`${s.raceLaps}-lap race`);
  if (s.pitStops) parts.push(n(s.pitStops, 'pit stop'));
  if (s.tyreWear !== 1) parts.push(`tyre wear ×${s.tyreWear}`);
  if (s.weather !== 'dry') parts.push(`${WEATHER_TEXT[s.weather].toLowerCase()} weather`);
  if (!s.collisions) parts.push('no collisions');
  if (s.invalidPenalty) parts.push(`${s.invalidPenalty} s per lap cut`);
  if (s.car) parts.push(`${carName(s.car)} only`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------- the session, in words
export const fmtClock = (secs: number) => {
  const t = Math.max(0, Math.ceil(secs)), m = Math.floor(t / 60);
  return `${m}:${String(t - m * 60).padStart(2, '0')}`;
};
const firstSession = (s: RoomSettings) => (s.practice ? (s.practice > 1 ? 'Practice 1' : 'Practice') : s.qualifying !== 'none' ? 'Qualifying' : 'the race');

export function sessionTitle(se: SessionInfo, s: RoomSettings): string {
  switch (se.phase) {
    case 'lobby': return 'Lobby';
    case 'practice': return s.practice > 1 ? `Practice ${se.index} of ${s.practice}` : 'Practice';
    case 'qualifying': return se.oneShot ? 'One-shot qualifying' : 'Qualifying';
    case 'race': return se.stage === 'results' ? 'Race results' : `Race · ${n(s.raceLaps, 'lap')}`;
  }
}

// The session's state at relay time t: a big figure (a clock, the lap; null: none) and a line saying what it is.
export function sessionState(se: SessionInfo, s: RoomSettings, t: number, leaderLaps = 0): { big: string | null; text: string } {
  const left = (at: number | null) => fmtClock((at ?? t) - t);
  switch (se.phase) {
    case 'lobby': return { big: null, text: 'Free driving until the host starts the weekend.' };
    case 'practice': return { big: left(se.end), text: 'left in the session' };
    case 'qualifying':
      if (se.oneShot) return se.goAt != null && t < se.goAt ? { big: left(se.goAt), text: 'until the cars are released: one flying lap each' }
        : { big: left(se.end), text: 'to finish your lap' };
      return se.stage === 'finishing' ? { big: left(se.end), text: 'Chequered flag: finish the lap you are on' } : { big: left(se.end), text: 'left: your best lap sets the grid' };
    case 'race':
      if (se.stage === 'results') return { big: left(se.end), text: 'until the lobby' };
      if (se.stage === 'finishing') return { big: left(se.end), text: 'The winner is home: the others finish this lap' };
      if (se.goAt != null && t >= se.goAt) return { big: `Lap ${Math.min(leaderLaps + 1, s.raceLaps)}/${s.raceLaps}`, text: 'the leader is on' };
      if (se.lightsAt != null && t >= se.lightsAt) return { big: 'Lights', text: 'Lights out any moment' };
      return { big: left(se.lightsAt), text: 'to the start lights: the cars are held on the grid' };
  }
}

export function nextSession(se: SessionInfo, s: RoomSettings): string {
  switch (se.phase) {
    case 'lobby': return `First: ${firstSession(s)}`;
    case 'practice': return se.index < s.practice ? `Next: Practice ${se.index + 1}` : s.qualifying !== 'none' ? 'Next: Qualifying' : `Next: the race, ${n(s.raceLaps, 'lap')}`;
    case 'qualifying': return `Next: the race, ${n(s.raceLaps, 'lap')}`;
    case 'race': return se.stage === 'results' ? 'Next: back to the lobby' : 'Then: the results, and back to the lobby';
  }
}

// The host's skip button for the session, and what the confirmation says.
export function skipLabel(se: SessionInfo): string {
  switch (se.phase) {
    case 'practice': return 'End practice now';
    case 'qualifying': return 'End qualifying now';
    case 'race': return se.stage === 'results' ? 'Back to the lobby now' : 'End the race now';
    default: return '';
  }
}

// ---------------------------------------------------------------------------- results tables
export interface ResultRow { pos: string; player: number; name: string; car: string; laps: string; time: string; best: string; pits: string; penalty: string; out: boolean }

// The race classification as table rows: the winner's total time, the others' gap to it (or laps behind).
export function raceRows(standings: readonly Standing[]): ResultRow[] {
  const lead = standings[0], total = (r: Standing) => (r.time ?? 0) + r.penalty;
  return standings.map((r, k) => {
    const out = r.status === 'dnf' || r.status === 'outOfTime';
    let time: string;
    if (r.status === 'dnf') time = 'DNF';
    else if (r.status === 'outOfTime') time = 'Out of time';
    else if (r.time == null) time = '—';
    else if (k === 0) time = fmtTime(total(r));
    else if (r.laps < lead.laps) time = `+${n(lead.laps - r.laps, 'lap')}`;
    else time = `+${(total(r) - total(lead)).toFixed(3)}`;
    return { pos: out && r.status === 'dnf' ? '—' : String(k + 1), player: r.player, name: r.name, car: carName(r.car), laps: String(r.laps), time,
      best: fmtTime(r.best), pits: String(r.pits), penalty: r.penalty ? `+${Math.round(r.penalty)} s` : '', out };
  });
}

// A board (best laps: lobby, practice, qualifying) as table rows: best lap, and the gap to the fastest.
export function boardRows(board: readonly BoardEntry[]): ResultRow[] {
  const top = board[0]?.best;
  return board.map((b, k) => ({ pos: String(k + 1), player: b.player, name: b.name, car: carName(b.car), laps: String(b.laps),
    time: k === 0 ? fmtTime(b.best) : `+${(b.best - top).toFixed(3)}`, best: fmtTime(b.best), pits: '', penalty: '', out: b.player === 0 }));
}

// ---------------------------------------------------------------------------- players
export type PlayerState = 'you' | 'waiting' | 'driving' | 'menu' | 'pits' | 'spectating' | 'finished' | 'retired' | 'noSignal';
export const PLAYER_STATE_TEXT: Record<PlayerState, string> = {
  you: 'You', waiting: 'Joining', driving: 'On track', menu: 'In the menu', pits: 'In the pits', spectating: 'Spectating',
  finished: 'Finished', retired: 'Retired', noSignal: 'No signal',
};
const sampleBuf: RemoteSample = emptySample();
export function playerState(net: NetClient, id: number, now: number): PlayerState {
  if (id === net.selfId) return 'you';
  const s = net.sample(id, now, sampleBuf, false);
  if (!s) return 'waiting';
  if (s.age > 1.5) return 'noSignal';
  if (s.flags & STATE_FLAG.paused) return 'menu';
  if (s.reason === CAR_REASON.pits) return 'pits';
  if (s.reason === CAR_REASON.finished) return 'finished';
  if (s.reason === CAR_REASON.retired) return 'retired';
  if (s.reason === CAR_REASON.spectator || net.isSpectator(id)) return 'spectating';
  return 'driving';
}

// ---------------------------------------------------------------------------- RoomLog
// What the menu keeps from the room's events: the last qualifying's times (the board is reset when the race
// starts), kept until the next weekend starts. Fed every event, in order (main.ts).
export class RoomLog {
  qualifying: BoardEntry[] | null = null;
  qualifyingOneShot = false;
  private board: BoardEntry[];
  private phase: Phase;
  constructor(net: NetClient) { this.board = net.board; this.phase = net.session.phase; }
  feed(e: NetEvent) {
    if (e.type === 'board') this.board = e.board;
    else if (e.type === 'session') {
      const was = e.before.phase, now = e.session.phase;
      if (was === 'lobby' && now !== 'lobby') this.qualifying = null;            // a new weekend
      if (was === 'qualifying' && now !== 'qualifying') { this.qualifying = this.board.slice(); this.qualifyingOneShot = e.before.oneShot; }
      this.phase = now;
    }
  }
  get inPhase() { return this.phase; }
}

// ---------------------------------------------------------------------------- why a room could not be entered
// What to tell the player when the relay refused the hello (code: ERROR), or nothing came of it. offer: the one
// thing to do about it, if there is one.
export type JoinOffer = 'reload' | 'create' | 'retry';
export function joinErrorText(code: number | null, room: string, server: string, relayMessage = ''): { text: string; offer?: JoinOffer } {
  switch (code) {
    case null: return { text: `Could not reach the relay at ${server}. Check your connection, or the relay address under "Relay".`, offer: 'retry' };
    case ERROR.noRoom: return { text: `There is no room ${room}: it may have closed (a room closes a minute after everyone leaves). Check the code, or open it again.`, offer: 'create' };
    case ERROR.roomFull: return { text: `Room ${room} is full.`, offer: 'retry' };
    case ERROR.version: return { text: 'This copy of the game is older than the relay. Reload the page to update it.', offer: 'reload' };
    case ERROR.serverFull: return { text: 'The relay is full at the moment. Try again in a while.', offer: 'retry' };
    case ERROR.badName: return { text: 'The relay did not accept that name: choose another.' };
    case ERROR.roomTaken: return { text: `Room ${room} is already open: join it instead.` };
    case ERROR.shutdown: return { text: 'The relay is shutting down. Try again in a moment.', offer: 'retry' };
    default: return { text: relayMessage || `The relay at ${server} did not let us in.`, offer: 'retry' };
  }
}

// What to tell the player when the room's connection ended (fatal: the relay's last fatal error, if it sent one).
export function closedText(room: string, reason: string, fatal: { code: number; message: string } | null): string {
  if (fatal?.code === ERROR.replaced) return `You joined room ${room} from another tab or window, so this one has left it.`;
  if (fatal?.code === ERROR.shutdown) return `The relay closed room ${room}: it is restarting or shutting down.`;
  if (fatal?.code === ERROR.idle) return `The relay stopped hearing from this game, so it left room ${room}.`;
  if (fatal) return `Room ${room}: ${fatal.message}`;
  return `Lost the connection to room ${room}${reason && reason !== 'closed' ? ` (${reason})` : ''}.`;
}
