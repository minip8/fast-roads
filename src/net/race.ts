import { WEATHER_KINDS, type WeatherKind } from './weather';

// ============================================================================
// Race weekends (docs/net.md, **Race weekends**): the room's settings, its session (phase), the race
// classification, and the pure helpers both sides use. No I/O. The relay owns all of it; clients get it in the
// welcome and on every change, and only the host may change the settings or start, skip and abort sessions.
// ============================================================================
export const QUALIFYING = ['none', 'timed', 'oneShot'] as const;
export type Qualifying = (typeof QUALIFYING)[number];
export const GRID_ORDERS = ['qualifying', 'random', 'reversed', 'joinOrder'] as const;
export type GridOrder = (typeof GRID_ORDERS)[number];
export const TYRE_WEAR = [0.5, 1, 2, 3, 5] as const;           // multipliers of the tyre model's wear (never 0)
export const INVALID_PENALTIES = [0, 1, 2, 3, 5, 10] as const;  // s per invalid race lap

export interface RoomSettings {
  circuit: string;               // a circuit id; changing it (lobby only) means every client reloads onto it
  car: string;                   // '' any car, or the one car id allowed
  practice: number;              // practice sessions, 0-3
  practiceMinutes: number;       // each, 1-120
  qualifying: Qualifying;
  qualifyingMinutes: number;     // timed qualifying, 1-60
  raceLaps: number;              // 1-99
  grid: GridOrder;               // with qualifying 'none', 'qualifying' and 'reversed' become 'joinOrder'
  pitStops: number;              // mandatory stops in the race, 0-3
  tyreWear: number;              // one of TYRE_WEAR
  weather: WeatherKind;
  collisions: boolean;           // in the race (practice and timed qualifying always collide; one-shot never)
  invalidPenalty: number;        // s added per invalid race lap, one of INVALID_PENALTIES
  finishSecs: number;            // s the others have to finish after the winner, 30-600
}
export const SETTING_RANGES = {
  practice: [0, 3], practiceMinutes: [1, 120], qualifyingMinutes: [1, 60], raceLaps: [1, 99], pitStops: [0, 3],
  finishSecs: [30, 600],
} as const;

export function defaultSettings(circuit: string): RoomSettings {
  return {
    circuit, car: '', practice: 1, practiceMinutes: 10, qualifying: 'timed', qualifyingMinutes: 10, raceLaps: 5,
    grid: 'qualifying', pitStops: 0, tyreWear: 1, weather: 'dry', collisions: true, invalidPenalty: 0, finishSecs: 120,
  };
}

// Settings made valid: numbers rounded and clamped to their ranges, tyre wear and the penalty to the nearest allowed
// value, unknown enum values to the default, the grid order to joinOrder when there is no qualifying to order by.
// (Ids are checked by the relay against the ones it knows; this leaves them as they are.)
export function normaliseSettings(s: RoomSettings): RoomSettings {
  const d = defaultSettings(s.circuit);
  const int = (v: number, [lo, hi]: readonly [number, number], dflt: number) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : dflt);
  const nearest = (v: number, opts: readonly number[], dflt: number) => (Number.isFinite(v) ? opts.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a)) : dflt);
  const r = SETTING_RANGES;
  const qualifying = QUALIFYING.includes(s.qualifying) ? s.qualifying : d.qualifying;
  let grid = GRID_ORDERS.includes(s.grid) ? s.grid : d.grid;
  if (qualifying === 'none' && (grid === 'qualifying' || grid === 'reversed')) grid = 'joinOrder';
  return {
    circuit: s.circuit, car: s.car,
    practice: int(s.practice, r.practice, d.practice), practiceMinutes: int(s.practiceMinutes, r.practiceMinutes, d.practiceMinutes),
    qualifying, qualifyingMinutes: int(s.qualifyingMinutes, r.qualifyingMinutes, d.qualifyingMinutes),
    raceLaps: int(s.raceLaps, r.raceLaps, d.raceLaps), grid, pitStops: int(s.pitStops, r.pitStops, d.pitStops),
    tyreWear: nearest(s.tyreWear, TYRE_WEAR, d.tyreWear), weather: WEATHER_KINDS.includes(s.weather) ? s.weather : d.weather,
    collisions: !!s.collisions, invalidPenalty: nearest(s.invalidPenalty, INVALID_PENALTIES, d.invalidPenalty),
    finishSecs: int(s.finishSecs, r.finishSecs, d.finishSecs),
  };
}

// ---------------------------------------------------------------------------- the session (phase)
export const PHASES = ['lobby', 'practice', 'qualifying', 'race'] as const;
export type Phase = (typeof PHASES)[number];
// running: the session's clock is on. finishing: timed qualifying's last laps after the flag, or the race after
// the winner finished. results: the race is over (classification final) until `end`, then the lobby.
export const STAGES = ['running', 'finishing', 'results'] as const;
export type Stage = (typeof STAGES)[number];

// Every time is the relay clock (s). null: none.
export interface SessionInfo {
  phase: Phase;
  index: number;                 // practice: 1-3; otherwise 0
  stage: Stage;
  collisions: boolean;           // cars collide in this session
  oneShot: boolean;              // one-shot qualifying: one flying lap each, all released at goAt, ghosts to each other
  start: number;                 // the session (or the lobby) began
  end: number | null;            // the current stage ends (practice / qualifying: the flag; finishing: the deadline;
                                 // the race while running: a safety stop at RelayOptions.maxRaceLapSecs a lap)
  lightsAt: number | null;       // race: the first of the five lights comes on; one a second, all five at lightsAt + 4
  goAt: number | null;           // race: the lights go out; one-shot: the cars are released at the start spot
  finishAt: number | null;       // race: the winner's crossing of the line (finishing and results)
  seed: number;                  // u32 of this session (its weather; free for the game's own use)
  grid: number[];                // race: player ids in grid order (slot = index); one-shot: who takes part
}
export function lobbySession(start: number): SessionInfo {
  return { phase: 'lobby', index: 0, stage: 'running', collisions: true, oneShot: false, start, end: null,
    lightsAt: null, goAt: null, finishAt: null, seed: 0, grid: [] };
}

export const LIGHTS = 5;
export type RaceStage = 'grid' | 'lights' | 'racing' | 'finishing' | 'results';
// Where a race is at relay time t (null: the session is not a race).
export function raceStage(s: SessionInfo, t: number): RaceStage | null {
  if (s.phase !== 'race') return null;
  if (s.stage === 'results') return 'results';
  if (s.stage === 'finishing') return 'finishing';
  if (s.goAt != null && t >= s.goAt) return 'racing';
  if (s.lightsAt != null && t >= s.lightsAt) return 'lights';
  return 'grid';
}
// How many of the five start lights are lit at relay time t (0 before the sequence and once they are out).
export function lightsLit(s: SessionInfo, t: number): number {
  if (s.phase !== 'race' || s.lightsAt == null || s.goAt == null || t < s.lightsAt || t >= s.goAt) return 0;
  return Math.min(LIGHTS, 1 + Math.floor(t - s.lightsAt));
}

// ---------------------------------------------------------------------------- race classification
export const STANDING_STATUS = ['racing', 'finished', 'dnf', 'outOfTime'] as const;
export type StandingStatus = (typeof STANDING_STATUS)[number];
export interface Standing {
  player: number;                // 0 once the player has left for good
  name: string; car: string;
  status: StandingStatus;        // dnf: left the race; outOfTime: still racing when the race ended
  grid: number | null;           // grid slot (0 = pole)
  laps: number;                  // laps completed
  time: number | null;           // s from the lights going out to the last crossing (null: no lap yet), penalty excluded
  penalty: number;               // s: invalid laps x the setting, and a missed mandatory stop once the race is over
  best: number | null;           // best valid lap (s)
  pits: number;                  // pit stops made
  invalid: number;               // invalid laps
}

// ---------------------------------------------------------------------------- car state extras
// Tyre compound in a car state (3 bits; the game maps its own compounds onto these).
export const COMPOUND = { unknown: 0, soft: 1, medium: 2, hard: 3, inter: 4, wet: 5 } as const;
// Why a car is shown as it is (3 bits), mostly why it does not collide: for displays (a ghost, a "PIT" tag).
export const CAR_REASON = { none: 0, pits: 1, spectator: 2, ghost: 3, paused: 4, finished: 5, retired: 6 } as const;
