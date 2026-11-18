import type { GridOrder, Standing, StandingStatus } from '../src/net/race';

// ============================================================================
// The pure parts of a race weekend on the relay (docs/net.md, **Race weekends**): the grid order and the race
// classification. relay.ts runs the phases and calls these.
// ============================================================================

export interface GridCandidate { id: number; joinedAt: number }

// Player ids in grid order (pole first). qualifying / reversed: the players with a qualifying time by it (reversed:
// slowest first), then those without one in join order; random: a shuffle of everyone (from `random`); joinOrder:
// longest in the room first.
export function gridOrder(order: GridOrder, players: readonly GridCandidate[], best: ReadonlyMap<number, number>, random: () => number): number[] {
  const joined = [...players].sort((a, b) => a.joinedAt - b.joinedAt || a.id - b.id).map((p) => p.id);
  if (order === 'joinOrder') return joined;
  if (order === 'random') {
    const out = joined.slice();
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
    return out;
  }
  const timed = joined.filter((id) => best.has(id)).sort((a, b) => best.get(a)! - best.get(b)!);
  if (order === 'reversed') timed.reverse();
  return [...timed, ...joined.filter((id) => !best.has(id))];
}

// A car in the race, as the relay keeps it.
export interface Entry {
  player: number; name: string; car: string;
  grid: number;                   // slot
  status: StandingStatus;
  laps: number;
  lastCrossing: number | null;    // relay time of the last accepted lap's crossing
  best: number | null;
  pits: number; invalid: number;
}

export interface ClassifyRules {
  goAt: number;                   // lights out (relay time)
  pitStops: number;               // mandatory stops
  missedStopPenalty: number;      // s, once the race is over, for a car that made fewer
  final: boolean;
}

// The classification: everyone still classified (racing, finished, out of time) by laps completed, then the time
// of the last crossing plus penalties, then grid slot; those who left (dnf) after them, by laps then crossing.
export function classify(entries: Iterable<Entry>, r: ClassifyRules): Standing[] {
  const rows = [...entries].map((e) => {
    // (invalid laps cost no time: the race's track limits rule is the client's, strikes and the pit limiter)
    let penalty = 0;
    if (r.final && e.status !== 'dnf' && e.pits < r.pitStops) penalty += r.missedStopPenalty;
    const time = e.lastCrossing == null ? null : e.lastCrossing - r.goAt;
    const s: Standing = { player: e.player, name: e.name, car: e.car, status: e.status, grid: e.grid, laps: e.laps, time, penalty,
      best: e.best, pits: e.pits, invalid: e.invalid };
    return s;
  });
  const key = (s: Standing) => (s.time == null ? Infinity : s.time + (s.status === 'dnf' ? 0 : s.penalty));
  rows.sort((a, b) => Number(a.status === 'dnf') - Number(b.status === 'dnf') || b.laps - a.laps || key(a) - key(b) || (a.grid ?? 0) - (b.grid ?? 0));
  return rows;
}
