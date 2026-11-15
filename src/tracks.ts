import melbourneCsv from '../tracks/melbourne.csv?raw';
import silverstoneCsv from '../tracks/silverstone.csv?raw';
import type { CarId } from './cars';

// ============================================================================
// Circuits. Each is a TUM racetrack-database CSV (centreline + widths, starting at the start/finish line and running
// in the racing direction) plus the few things that differ between venues. Everything else (kerbs, gravel, barriers,
// timing lines, brake boards, the autopilot's speed plan) is derived from the centreline by track.ts and friends.
// ============================================================================
export type TrackId = 'melbourne' | 'silverstone';

export interface TrackDef {
  id: TrackId;
  name: string; place: string;      // "Albert Park", "Melbourne"
  csv: string;
  storeKey: string;                 // localStorage key for best times here (each car adds its own suffix)
  startBack: number;                // m before the start/finish line where the car starts (on the straight)
  // The car starts already on a flying lap: each car's speed (km/h) at the start spot, taken from the autopilot
  // arriving there at the end of a lap (the lap tests check they still agree).
  flying: Record<CarId, number>;
  // scenery, placed relative to the start/finish line
  pit: [from: number, to: number];  // pit building, from/to this many metres after the line (negative = before)
  stands: [back: number, fwd: number];   // grandstand bays (26 m each) before and after the line
  skyline: boolean;                 // a city on the horizon
  trees: number;                    // how many trees to scatter round the circuit
  pitSide: 1 | -1;                  // pit building on the left (1) or right (-1) of the start straight; stands opposite
}

export const TRACKS: Record<TrackId, TrackDef> = {
  melbourne: {
    id: 'melbourne', name: 'Albert Park', place: 'Melbourne', csv: melbourneCsv, storeKey: 'fastroads.v1.melbourne',
    startBack: 160, flying: { f1: 274, drift: 219, gt3: 207, lcgt3: 206, lcf1: 232 },
    pit: [-220, 80], stands: [16, 3],
    skyline: true, trees: 1800, pitSide: 1,
  },
  // Grand Prix layout, starting on the Hamilton Straight just after Club: only ~75 m of straight before the line,
  // so the start spot and the buildings sit further forward. A former airfield in open country: no skyline, fewer trees,
  // and the pit complex on the inside (right) of the straight.
  silverstone: {
    id: 'silverstone', name: 'Silverstone', place: 'England', csv: silverstoneCsv, storeKey: 'fastroads.v1.silverstone',
    startBack: 60, flying: { f1: 142, drift: 117, gt3: 127, lcgt3: 125, lcf1: 151 },
    pit: [-60, 240], stands: [3, 13],
    skyline: false, trees: 900, pitSide: -1,
  },
};
