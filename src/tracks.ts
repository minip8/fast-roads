import type { CarId } from './cars';

// ============================================================================
// Circuits: the 2026 Formula 1 calendar. Each is a CSV in tracks/ (centreline + widths, starting at the start/finish
// line and running in the racing direction: TUM racetrack-database files, or bacinger/f1-circuits centrelines
// converted by scripts/tracks/convert.mjs) plus the few things that differ between venues. Everything else (kerbs,
// gravel, barriers, timing lines, brake boards, the autopilot's speed plan) is derived from the centreline by track.ts
// and friends. Only the chosen circuit's CSV is loaded (loadTrackCsv).
// ============================================================================
export type TrackId =
  | 'melbourne' | 'shanghai' | 'suzuka' | 'miami' | 'montreal' | 'monaco' | 'barcelona' | 'spielberg' | 'silverstone'
  | 'spa' | 'hungaroring' | 'zandvoort' | 'monza' | 'madrid' | 'baku' | 'singapore' | 'austin' | 'mexico' | 'saopaulo'
  | 'lasvegas' | 'lusail' | 'yasmarina' | 'bahrain' | 'jeddah';

export interface TrackDef {
  id: TrackId;
  name: string; place: string;      // "Albert Park", "Melbourne"
  // for display (the circuit picker)
  country: string;
  lengthKm: number;                 // official lap length (the CSV's own is within about 1%: test/tracks.test.ts)
  round?: number;                   // round of the 2026 championship; none for the two rounds cancelled that year
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

// The rest of a circuit's definition: storeKey follows from the id.
type Def = Omit<TrackDef, 'id' | 'storeKey'>;
const def = (id: TrackId, d: Def): TrackDef => ({ id, storeKey: `fastroads.v1.${id}`, ...d });

// In calendar order. Pits sit on the inside of the lap where nothing else is in the way.
export const TRACKS: Record<TrackId, TrackDef> = {
  melbourne: def('melbourne', {
    name: 'Albert Park', place: 'Melbourne', country: 'Australia', lengthKm: 5.278, round: 1,
    startBack: 160, flying: { drift: 219, lcgt3: 206, lcf1: 232 },
    pit: [-220, 80], stands: [16, 3],
    skyline: true, trees: 1800, pitSide: 1,
  }),
  shanghai: def('shanghai', {
    name: 'Shanghai International Circuit', place: 'Shanghai', country: 'China', lengthKm: 5.451, round: 2,
    startBack: 150, flying: { drift: 158, lcgt3: 147, lcf1: 195 },
    pit: [-200, 250], stands: [8, 10],
    skyline: true, trees: 400, pitSide: -1,
  }),
  suzuka: def('suzuka', {
    name: 'Suzuka', place: 'Suzuka', country: 'Japan', lengthKm: 5.807, round: 3,
    startBack: 60, flying: { drift: 173, lcgt3: 186, lcf1: 217 },
    pit: [-50, 300], stands: [2, 12],
    skyline: false, trees: 1500, pitSide: -1,
  }),
  miami: def('miami', {
    name: 'Miami International Autodrome', place: 'Miami', country: 'United States', lengthKm: 5.412, round: 4,
    startBack: 150, flying: { drift: 176, lcgt3: 205, lcf1: 231 },
    pit: [-170, 190], stands: [6, 7],
    skyline: false, trees: 400, pitSide: 1,
  }),
  montreal: def('montreal', {
    name: 'Circuit Gilles Villeneuve', place: 'Montreal', country: 'Canada', lengthKm: 4.361, round: 5,
    startBack: 160, flying: { drift: 209, lcgt3: 191, lcf1: 235 },
    pit: [-350, 20], stands: [13, 0],
    skyline: true, trees: 900, pitSide: -1,
  }),
  monaco: def('monaco', {
    name: 'Monaco', place: 'Monte Carlo', country: 'Monaco', lengthKm: 3.337, round: 6,
    startBack: 100, flying: { drift: 164, lcgt3: 167, lcf1: 197 },
    pit: [-100, 20], stands: [1, 2],
    skyline: true, trees: 300, pitSide: -1,
  }),
  barcelona: def('barcelona', {
    name: 'Barcelona-Catalunya', place: 'Montmeló', country: 'Spain', lengthKm: 4.657, round: 7,
    startBack: 160, flying: { drift: 208, lcgt3: 195, lcf1: 222 },
    pit: [-300, 300], stands: [12, 12],
    skyline: false, trees: 900, pitSide: -1,
  }),
  spielberg: def('spielberg', {
    name: 'Red Bull Ring', place: 'Spielberg', country: 'Austria', lengthKm: 4.318, round: 8,
    startBack: 150, flying: { drift: 162, lcgt3: 172, lcf1: 204 },
    pit: [-180, 300], stands: [6, 12],
    skyline: false, trees: 1500, pitSide: -1,
  }),
  // Grand Prix layout, starting on the Hamilton Straight just after Club: only ~75 m of straight before the line,
  // so the start spot and the buildings sit further forward. A former airfield in open country: no skyline, fewer trees,
  // and the pit complex on the inside (right) of the straight.
  silverstone: def('silverstone', {
    name: 'Silverstone', place: 'England', country: 'United Kingdom', lengthKm: 5.891, round: 9,
    startBack: 60, flying: { drift: 117, lcgt3: 125, lcf1: 151 },
    pit: [-60, 240], stands: [3, 13],
    skyline: false, trees: 900, pitSide: -1,
  }),
  spa: def('spa', {
    name: 'Spa-Francorchamps', place: 'Stavelot', country: 'Belgium', lengthKm: 7.004, round: 10,
    startBack: 120, flying: { drift: 119, lcgt3: 118, lcf1: 148 },
    pit: [-140, 300], stands: [5, 12],
    skyline: false, trees: 2500, pitSide: -1,
  }),
  hungaroring: def('hungaroring', {
    name: 'Hungaroring', place: 'Budapest', country: 'Hungary', lengthKm: 4.381, round: 11,
    startBack: 130, flying: { drift: 149, lcgt3: 157, lcf1: 182 },
    pit: [-150, 350], stands: [5, 14],
    skyline: false, trees: 1200, pitSide: -1,
  }),
  zandvoort: def('zandvoort', {
    name: 'Zandvoort', place: 'Zandvoort', country: 'Netherlands', lengthKm: 4.259, round: 12,
    startBack: 160, flying: { drift: 195, lcgt3: 201, lcf1: 233 },
    pit: [-250, 250], stands: [10, 12],
    skyline: false, trees: 500, pitSide: -1,
  }),
  monza: def('monza', {
    name: 'Monza', place: 'Monza', country: 'Italy', lengthKm: 5.793, round: 13,
    startBack: 160, flying: { drift: 220, lcgt3: 224, lcf1: 233 },
    pit: [-150, 250], stands: [10, 16],
    skyline: false, trees: 2500, pitSide: -1,
  }),
  madrid: def('madrid', {
    name: 'Madring', place: 'Madrid', country: 'Spain', lengthKm: 5.414, round: 14,
    startBack: 160, flying: { drift: 209, lcgt3: 193, lcf1: 227 },
    pit: [-300, 140], stands: [12, 5],
    skyline: true, trees: 300, pitSide: -1,
  }),
  baku: def('baku', {
    name: 'Baku City Circuit', place: 'Baku', country: 'Azerbaijan', lengthKm: 6.003, round: 15,
    startBack: 160, flying: { drift: 222, lcgt3: 268, lcf1: 278 },
    pit: [-400, 120], stands: [14, 4],
    skyline: true, trees: 300, pitSide: 1,
  }),
  singapore: def('singapore', {
    name: 'Marina Bay', place: 'Singapore', country: 'Singapore', lengthKm: 4.927, round: 16,
    startBack: 160, flying: { drift: 209, lcgt3: 195, lcf1: 228 },
    pit: [-300, 80], stands: [12, 3],
    skyline: true, trees: 600, pitSide: 1,
  }),
  austin: def('austin', {
    name: 'Circuit of the Americas', place: 'Austin', country: 'United States', lengthKm: 5.513, round: 17,
    startBack: 90, flying: { drift: 109, lcgt3: 111, lcf1: 135 },
    pit: [-100, 400], stands: [4, 14],
    skyline: false, trees: 500, pitSide: 1,
  }),
  mexico: def('mexico', {
    name: 'Autódromo Hermanos Rodríguez', place: 'Mexico City', country: 'Mexico', lengthKm: 4.304, round: 18,
    startBack: 160, flying: { drift: 186, lcgt3: 187, lcf1: 224 },
    pit: [-250, 500], stands: [9, 18],
    skyline: true, trees: 600, pitSide: -1,
  }),
  saopaulo: def('saopaulo', {
    name: 'Interlagos', place: 'São Paulo', country: 'Brazil', lengthKm: 4.309, round: 19,
    startBack: 160, flying: { drift: 200, lcgt3: 238, lcf1: 246 },
    pit: [-200, 250], stands: [7, 9],
    skyline: true, trees: 900, pitSide: 1,
  }),
  lasvegas: def('lasvegas', {
    name: 'Las Vegas Strip Circuit', place: 'Las Vegas', country: 'United States', lengthKm: 6.201, round: 20,
    startBack: 160, flying: { drift: 160, lcgt3: 165, lcf1: 201 },
    pit: [-200, 70], stands: [7, 2],
    skyline: true, trees: 100, pitSide: 1,
  }),
  lusail: def('lusail', {
    name: 'Lusail International Circuit', place: 'Lusail', country: 'Qatar', lengthKm: 5.419, round: 21,
    startBack: 160, flying: { drift: 222, lcgt3: 235, lcf1: 259 },
    pit: [-400, 380], stands: [15, 14],
    skyline: true, trees: 60, pitSide: -1,
  }),
  yasmarina: def('yasmarina', {
    name: 'Yas Marina', place: 'Abu Dhabi', country: 'United Arab Emirates', lengthKm: 5.281, round: 22,
    startBack: 160, flying: { drift: 163, lcgt3: 155, lcf1: 191 },
    pit: [-230, 200], stands: [9, 8],
    skyline: false, trees: 150, pitSide: 1,
  }),
  // On the 2026 calendar as published, then cancelled (no round).
  bahrain: def('bahrain', {
    name: 'Bahrain International Circuit', place: 'Sakhir', country: 'Bahrain', lengthKm: 5.412,
    startBack: 160, flying: { drift: 209, lcgt3: 196, lcf1: 231 },
    pit: [-300, 400], stands: [12, 15],
    skyline: false, trees: 60, pitSide: -1,
  }),
  jeddah: def('jeddah', {
    name: 'Jeddah Corniche Circuit', place: 'Jeddah', country: 'Saudi Arabia', lengthKm: 6.174,
    startBack: 160, flying: { drift: 222, lcgt3: 229, lcf1: 258 },
    pit: [-350, 300], stands: [15, 13],
    skyline: true, trees: 80, pitSide: 1,
  }),
};

// The circuit's CSV text. Each is its own small chunk in the build, fetched only for the circuit being driven.
const CSV = import.meta.glob<string>('../tracks/*.csv', { query: '?raw', import: 'default' });
export function loadTrackCsv(id: TrackId): Promise<string> {
  const load = CSV[`../tracks/${id}.csv`];
  if (!load) throw new Error(`no tracks/${id}.csv`);
  return load();
}
