import { CARS, type CarId } from './cars';
import {
  type BoardEntry, CAR_REASON, emptySample, ERROR, GRID_ORDERS, INVALID_PENALTIES, NET_CARS, type NetClient, type NetEvent, normaliseSettings,
  type Phase, QUALIFYING, type RemoteSample, type RoomSettings, type SessionInfo, SETTING_RANGES, type Standing, STATE_FLAG, TYRE_WEAR,
  WEATHER_KINDS,
} from './net';
import { TRACKS, type TrackId } from './tracks';
import { fmtTime } from './util';

export { normaliseSettings } from './net';

// ============================================================================
// What the menu shows of a multiplayer room, without the DOM: the weekend settings as menu controls (built from
// src/net/race.ts's lists and ranges, so they cannot drift from what the relay takes), presets (types of weekend that
// set every option, the tyre wear from the race length and the circuit), tyre life in laps, the weekend and the
// session under way in plain words, the results tables, the players' states, and RoomLog (what the menu keeps of
// the room between events: the last qualifying's times). Loaded with netGame.ts (only in a room, so a
// single-player page never downloads src/net); menu.ts reads it through MenuHost.net.room().
// ============================================================================
export type RoomKey = Exclude<keyof RoomSettings, 'circuit'>;
export type RoomValue = RoomSettings[RoomKey];
// The host's options: the `main` ones always shown under the formats, the others behind "More options", by group.
export type FieldGroup = 'main' | 'sessions' | 'tyres' | 'rules';
export const FIELD_GROUPS: [FieldGroup, string][] = [['main', 'The race'], ['sessions', 'Practice and qualifying'], ['tyres', 'Tyres and pit stops'], ['rules', 'Rules']];

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
  shown?: (s: RoomSettings) => string;                 // steppers: the value as shown, when it depends on the others
  detail?: (s: RoomSettings) => string;                // a line under the hint that depends on the settings
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

// ---------------------------------------------------------------------------- tyre life
// About how many laps a fresh set lasts: the F1's at Melbourne (5.278 km) at wear rate 1, per km (README, Race
// conditions; weekend.ts tyreLife uses the same numbers). Every car's wear is scaled to about the F1's
// (CarInfo.race.wearScale), so a rate means about the same laps in each; the drift car has one all-weather tyre.
const MELBOURNE_KM = 5.278;
export type LifeTyre = 'soft' | 'medium' | 'hard' | 'wet' | 'allweather';
const TYRE_LAPS: Record<LifeTyre, number> = { soft: 43, medium: 64, hard: 90, wet: 64, allweather: 60 };
const circuitKm = (circuit: string) => (circuit in TRACKS ? TRACKS[circuit as TrackId].lengthKm : MELBOURNE_KM);
export function tyreLaps(tyre: LifeTyre, wear: number, circuit: string): number {
  return (TYRE_LAPS[tyre] * MELBOURNE_KM) / (circuitKm(circuit) * wear);
}
export const fmtLaps = (v: number) => (v >= 20 ? `${Math.round(v / 5) * 5}` : v >= 3 ? `${Math.round(v)}` : v.toFixed(1));
// The tyres a room's settings are about: the drift car's one tyre, wets in the wet, else the slicks.
const oneTyre = (s: RoomSettings) => !!s.car && s.car in CARS && CARS[s.car as CarId].physics === 'rapier';
function mainTyre(s: RoomSettings): [LifeTyre, string] {
  if (oneTyre(s)) return ['allweather', 'Tyres'];
  return s.weather === 'wet' ? ['wet', 'Wets'] : ['soft', 'Softs'];
}
// "Softs ~7 laps": what the race is run on, at the settings' wear and circuit.
export function tyreLifeShort(s: RoomSettings, wear = s.tyreWear): string {
  const [t, name] = mainTyre(s);
  return `${name} ~${fmtLaps(tyreLaps(t, wear, s.circuit))} laps`;
}
// Every slick (or the one tyre) here, in a line.
export function tyreLifeLong(s: RoomSettings, wear = s.tyreWear): string {
  const at = circuit(s.circuit);
  if (oneTyre(s)) return `A set lasts about ${fmtLaps(tyreLaps('allweather', wear, s.circuit))} laps of ${at}.`;
  const l = (t: LifeTyre) => fmtLaps(tyreLaps(t, wear, s.circuit));
  return `Softs last about ${l('soft')} laps of ${at}, mediums ${l('medium')}, hards ${l('hard')}; rain tyres about as mediums.`;
}
const circuit = (id: string) => (id in TRACKS ? TRACKS[id as TrackId].name : id);

export const ROOM_FIELDS: readonly RoomField[] = [
  { key: 'car', label: 'Cars', group: 'main', kind: 'choice', hint: 'Everyone races the same car, or each driver picks their own.',
    options: [...NET_CARS.map((id) => [id, carName(id)] as const), ['', 'Any car']] },
  { key: 'raceLaps', label: 'Race length', group: 'main', hint: 'Laps from the lights going out.',
    ...stepper(LAPS, SETTING_RANGES.raceLaps, (v) => n(v, 'lap')) },
  { key: 'qualifying', label: 'Qualifying', group: 'main', kind: 'choice',
    hint: 'Timed: the best lap in the time sets the grid. One shot: a single flying lap each, no traffic.',
    options: QUALIFYING.map((v) => [v, QUALIFYING_TEXT[v]] as const) },
  { key: 'weather', label: 'Weather', group: 'main', kind: 'choice',
    hint: 'Damp and wet start with water on the track, changeable brings showers, random picks one.',
    options: WEATHER_KINDS.map((v) => [v, WEATHER_TEXT[v]] as const) },
  { key: 'practice', label: 'Practice sessions', group: 'sessions', kind: 'choice',
    hint: 'Free running before qualifying, to learn the circuit and try the tyres.',
    options: within([0, 1, 2, 3], SETTING_RANGES.practice).map((v) => [v, v ? String(v) : 'None'] as const) },
  { key: 'practiceMinutes', label: 'Practice length', group: 'sessions', hint: 'Each practice session.',
    ...stepper(MINUTES, SETTING_RANGES.practiceMinutes, mins), applies: (s) => s.practice > 0 },
  { key: 'qualifyingMinutes', label: 'Qualifying length', group: 'sessions',
    hint: 'Timed qualifying. A lap begun before the flag still counts.',
    ...stepper(MINUTES, SETTING_RANGES.qualifyingMinutes, mins), applies: (s) => s.qualifying === 'timed' },
  { key: 'grid', label: 'Starting grid', group: 'sessions', kind: 'choice',
    hint: 'Who starts where. Qualifying and reversed need a qualifying session.',
    options: GRID_ORDERS.map((v) => [v, GRID_TEXT[v]] as const),
    allowed: (v, s) => s.qualifying !== 'none' || (v !== 'qualifying' && v !== 'reversed') },
  // (most life first, so + means longer-lasting tyres)
  { key: 'tyreWear', label: 'Tyre life', group: 'tyres', kind: 'step', hint: 'Shorter-lived tyres make pit stops and tyre choice matter.',
    format: (v) => `×${v} wear`, options: [...TYRE_WEAR].reverse().map((v) => [v, `×${v} wear`] as const),
    shown: (s) => tyreLifeShort(s), detail: (s) => `${tyreLifeLong(s)} Wear ×${s.tyreWear} (×1 is real).` },
  { key: 'pitStops', label: 'Mandatory pit stops', group: 'tyres', kind: 'choice',
    hint: 'Stops every car must make in the race. A missed one costs 60 s.',
    options: within([0, 1, 2, 3], SETTING_RANGES.pitStops).map((v) => [v, v ? String(v) : 'None'] as const) },
  { key: 'collisions', label: 'Collisions in the race', group: 'rules', kind: 'choice',
    hint: 'Off: cars pass through each other. Practice and timed qualifying always collide.',
    options: [[true, 'On'], [false, 'Off']] },
  { key: 'invalidPenalty', label: 'Track limits penalty', group: 'rules', kind: 'choice', hint: 'Added to your race time for each lap cut off the track.',
    options: INVALID_PENALTIES.map((v) => [v, v ? `${v} s` : 'None'] as const) },
  { key: 'finishSecs', label: 'Time to finish', group: 'rules', hint: 'How long the others have after the winner crosses the line.',
    ...stepper(FINISH_SECS, SETTING_RANGES.finishSecs, fmtSecs) },
];

// The option shown for a value (a value between the options, which the relay can hold, shows as itself).
export function optionLabel(f: RoomField, v: RoomValue): string {
  return f.options.find(([o]) => o === v)?.[1] ?? (f.format && typeof v === 'number' ? f.format(v) : String(v));
}
// The next option from v in direction dir (in the options' order), skipping options not allowed: round from the last
// to the first with `wrap` (buttons), else stopping at the ends (steppers); v itself if there is none.
export function stepOption(f: RoomField, v: RoomValue, dir: number, s: RoomSettings, wrap = false): RoomValue {
  const ok = f.options.filter(([o]) => !f.allowed || f.allowed(o, s)).map(([o]) => o);
  const k = ok.indexOf(v);
  if (k >= 0) return ok[wrap ? (((k + dir) % ok.length) + ok.length) % ok.length : Math.max(0, Math.min(ok.length - 1, k + dir))];
  if (typeof v === 'number') {   // between options: the nearest one that way
    const nums = ok as number[], up = nums[0] < nums[nums.length - 1];
    const after = (o: number) => (up ? o > v : o < v);
    const next = dir > 0 ? nums.find(after) : [...nums].reverse().find((o) => !after(o));
    return next ?? v;
  }
  return ok[0] ?? v;
}

// ---------------------------------------------------------------------------- presets
// A type of weekend: every option but the circuit and the allowed car. The tyre wear is not fixed but follows from
// `life`: the race tyre (softs, or wets for a wet race) lasting that share of the race at this circuit, as the
// strategy wants it (a crude stint model of README's wear and lap-time numbers, a stop costing ~22 s): about 1.4
// races with no stop to make (the softs just last), 0.65 for one stop, 0.45 for two.
export interface Preset {
  id: string; name: string; blurb: string;
  settings: Omit<RoomSettings, 'circuit' | 'car' | 'tyreWear'>;
  tyre: 'soft' | 'wet';
  life: number;
}
const BASE = { practice: 0, practiceMinutes: 10, qualifying: 'none', qualifyingMinutes: 10, grid: 'qualifying', pitStops: 0, weather: 'dry',
  collisions: true, invalidPenalty: 0, finishSecs: 120 } as const;
export const PRESETS: readonly Preset[] = [
  { id: 'quick', name: 'Quick race', blurb: 'Straight onto a random grid: a short race, no stops.', tyre: 'soft', life: 1.4,
    settings: { ...BASE, raceLaps: 5, grid: 'random', finishSecs: 60 } },
  { id: 'sprint', name: 'Sprint', blurb: 'One flying lap each sets the grid, then a flat-out race.', tyre: 'soft', life: 1.4,
    settings: { ...BASE, qualifying: 'oneShot', raceLaps: 8, invalidPenalty: 2, finishSecs: 90 } },
  { id: 'gp', name: 'Grand Prix', blurb: 'The full weekend: practice, qualifying, and a race with a pit stop.', tyre: 'soft', life: 0.65,
    settings: { ...BASE, practice: 1, qualifying: 'timed', raceLaps: 15, pitStops: 1, invalidPenalty: 5 } },
  { id: 'endurance', name: 'Endurance', blurb: 'A long race on tyres that wear: two stops to plan.', tyre: 'soft', life: 0.45,
    settings: { ...BASE, practice: 1, practiceMinutes: 15, qualifying: 'timed', qualifyingMinutes: 15, raceLaps: 25, pitStops: 2, invalidPenalty: 5, finishSecs: 300 } },
  { id: 'wet', name: 'Wet race', blurb: 'Rain from the start: practice, qualifying and a race on wets.', tyre: 'wet', life: 1.4,
    settings: { ...BASE, practice: 1, qualifying: 'timed', raceLaps: 10, weather: 'wet', finishSecs: 180 } },
];
// A new room's format (the game sets it, with the host's car, when it creates a room).
export const DEFAULT_PRESET = PRESETS[1];

// The preset's wear at a circuit: the allowed step nearest what makes its tyre last `life` races.
export function presetWear(p: Preset, circuitId: string): number {
  const want = (TYRE_LAPS[p.tyre] * MELBOURNE_KM) / (circuitKm(circuitId) * p.life * p.settings.raceLaps);
  return TYRE_WEAR.reduce((a, b) => (Math.abs(Math.log(b / want)) < Math.abs(Math.log(a / want)) ? b : a));
}
export const withPreset = (s: RoomSettings, p: Preset): RoomSettings => normaliseSettings({ ...s, ...p.settings, tyreWear: presetWear(p, s.circuit) });
const PRESET_KEYS = Object.keys(PRESETS[0].settings) as (keyof Preset['settings'])[];
const matches = (p: Preset, s: RoomSettings) => PRESET_KEYS.filter((k) => p.settings[k] === s[k]).length + (s.tyreWear === presetWear(p, s.circuit) ? 1 : 0);
// The preset the settings are (circuit and car aside), or null: custom.
export function presetOf(s: RoomSettings): Preset | null {
  return PRESETS.find((p) => matches(p, s) === PRESET_KEYS.length + 1) ?? null;
}
// The preset custom settings are nearest (the one they were most likely made from).
export function closestPreset(s: RoomSettings): Preset {
  return PRESETS.reduce((a, b) => (matches(b, s) > matches(a, s) ? b : a));
}
// The settings at another circuit: a preset stays that preset (its tyre wear for the new circuit's length).
export function withCircuit(s: RoomSettings, circuitId: string): RoomSettings {
  const p = presetOf(s);
  return normaliseSettings({ ...s, circuit: circuitId, ...(p ? { tyreWear: presetWear(p, circuitId) } : {}) });
}
// A new room's settings: the default format, everyone in the host's car.
export const newRoomSettings = (s: RoomSettings, car: string): RoomSettings => withPreset({ ...s, car }, DEFAULT_PRESET);

// ---------------------------------------------------------------------------- the weekend, in words
const QUALI_SHORT: Record<RoomSettings['qualifying'], string> = { none: '', timed: 'qualifying', oneShot: 'one-shot qualifying' };
const GRID_SHORT: Record<RoomSettings['grid'], string> = { qualifying: 'grid by qualifying', random: 'random grid', reversed: 'reversed grid', joinOrder: 'grid in join order' };
const stopsText = (k: number) => (k ? n(k, 'stop') : 'no stops');
// One compact line: what the weekend is ("10 min practice · 10 min qualifying · 15 laps · 1 stop · softs ~10 laps · dry").
export function weekendSummary(s: RoomSettings, extras = true): string {
  const parts: string[] = [];
  if (s.practice) parts.push(`${s.practice > 1 ? `${s.practice} × ` : ''}${s.practiceMinutes} min practice`);
  if (s.qualifying === 'timed') parts.push(`${s.qualifyingMinutes} min ${QUALI_SHORT.timed}`);
  else if (s.qualifying === 'oneShot') parts.push(QUALI_SHORT.oneShot);
  else parts.push(GRID_SHORT[s.grid]);
  parts.push(n(s.raceLaps, 'lap'), stopsText(s.pitStops), tyreLifeShort(s).toLowerCase(), WEATHER_TEXT[s.weather].toLowerCase());
  if (extras) {
    if (!s.collisions) parts.push('no collisions');
    if (s.invalidPenalty) parts.push(`${s.invalidPenalty} s a lap off track`);
    parts.push(s.car ? `${carName(s.car)} only` : 'any car');
  }
  return parts.join(' · ');
}
// What a preset makes of these settings, in that line (its own options, the room's circuit and car).
export const presetSummary = (p: Preset, s: RoomSettings) => weekendSummary(withPreset(s, p), false);

const WEATHER_LONG: Record<RoomSettings['weather'], string> = {
  dry: 'Dry', damp: 'Damp: water on the track at the start', wet: 'Wet: rain from the start', changeable: 'Changeable: showers come and go',
  random: 'Random: one of dry, damp, wet or changeable',
};
// The whole weekend as label / text pairs, for those who cannot change it (and the host during a weekend).
export function weekendFacts(s: RoomSettings): [string, string][] {
  const p = presetOf(s);
  const sessions = [
    s.practice ? `${s.practice > 1 ? `${s.practice} × ` : ''}${s.practiceMinutes} min practice` : '',
    s.qualifying === 'timed' ? `${s.qualifyingMinutes} min qualifying` : s.qualifying === 'oneShot' ? 'one-shot qualifying (one flying lap each)' : '',
    `the race`,
  ].filter(Boolean).join(', then ');
  return [
    ['Format', p ? p.name : `Custom (based on ${closestPreset(s).name})`],
    ['Cars', s.car ? `Everyone in the ${carName(s.car)}` : 'Any car: each driver picks'],
    ['Sessions', sessions[0].toUpperCase() + sessions.slice(1)],
    ['Race', `${n(s.raceLaps, 'lap')}, ${GRID_SHORT[s.grid]}`],
    ['Tyres', `${s.pitStops ? `${n(s.pitStops, 'mandatory pit stop')}. ` : 'No mandatory stops. '}${tyreLifeLong(s)}`],
    ['Weather', WEATHER_LONG[s.weather]],
    ['Rules', [s.collisions ? 'Collisions on' : 'No collisions in the race', s.invalidPenalty ? `${s.invalidPenalty} s for each lap off the track` : 'no track limits penalty',
      `${fmtSecs(s.finishSecs)} to finish after the winner`].join(' · ')],
  ];
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
    case 'lobby': return `${presetOf(s)?.name ?? 'Custom weekend'} · first: ${firstSession(s)}`;
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
