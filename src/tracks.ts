import type { CarId } from './cars';
import type { LightId } from './timeOfDay';
import type { Buildings, Flora, SceneKind } from './trackside';

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
  // Where the car starts (and every restart puts it), m before the start/finish line: on the straight before the
  // last corner or corners, so the run-up to the line drives them, as on a real flying lap. Found by the rule in
  // test/flying.test.ts (npm run tracks:flying), unless startManual says why it was chosen by hand.
  startBack: number;
  startManual?: string;             // where a start chosen by hand is (tracks:flying prints the rule's spot beside it)
  // The car starts already on a flying lap: each car's speed (km/h) at the start spot, taken from the autopilot
  // passing there at the end of a lap (npm run tracks:flying; the lap tests check they still agree).
  flying: Record<CarId, number>;
  // scenery, placed relative to the start/finish line
  pit: [from: number, to: number];  // pit building, from/to this many metres after the line (negative = before)
  stands: [back: number, fwd: number];   // grandstand bays (26 m each) before and after the line
  skyline: boolean;                 // a city on the horizon
  trees: number;                    // how many trees to scatter round the circuit
  pitSide: 1 | -1;                  // pit building on the left (1) or right (-1) of the start straight; stands opposite
  street?: boolean;                 // a street circuit: walls close in, no gravel traps (buildTrack's option)
  // the place and its light (trackside.ts, timeOfDay.ts)
  scene: SceneKind;                 // the kind of place: the ground, how the trees stand, the hills' colour, city blocks
  flora?: Flora;                    // the trees (broadleaf if not given)
  hills: number;                    // the hills on the horizon: their greatest height (m)
  buildings?: Buildings;            // city blocks and skyline: heights, towers, façade colours, lit signs
  light: LightId;                   // the light its Grand Prix is raced in (timeOfDay.ts LOOKS)
  sunAz: number;                    // the sun's compass bearing then (deg; 180 = south)
}

// The rest of a circuit's definition: storeKey follows from the id.
type Def = Omit<TrackDef, 'id' | 'storeKey'>;
const def = (id: TrackId, d: Def): TrackDef => ({ id, storeKey: `fastroads.v1.${id}`, ...d });

// In calendar order. Pits sit on the inside of the lap where nothing else is in the way.
export const TRACKS: Record<TrackId, TrackDef> = {
  melbourne: def('melbourne', {
    name: 'Albert Park', place: 'Melbourne', country: 'Australia', lengthKm: 5.278, round: 1,
    startBack: 560, flying: { drift: 104, lcgt3: 108, lcf1: 131 },
    pit: [-220, 80], stands: [16, 3],
    skyline: true, trees: 1800, pitSide: 1,
    scene: 'park', hills: 15, light: 'clear', sunAz: 320,
  }),
  shanghai: def('shanghai', {
    name: 'Shanghai International Circuit', place: 'Shanghai', country: 'China', lengthKm: 5.451, round: 2,
    startBack: 424, flying: { drift: 174, lcgt3: 177, lcf1: 219 },
    pit: [-200, 250], stands: [8, 10],
    skyline: true, trees: 400, pitSide: -1,
    scene: 'country', hills: 10, light: 'haze', sunAz: 235,
  }),
  suzuka: def('suzuka', {
    name: 'Suzuka', place: 'Suzuka', country: 'Japan', lengthKm: 5.807, round: 3,
    startBack: 595, flying: { drift: 183, lcgt3: 199, lcf1: 225 },
    pit: [-50, 300], stands: [2, 12],
    skyline: false, trees: 3500, pitSide: -1,
    scene: 'forest', flora: 'mixed', hills: 160, light: 'golden', sunAz: 240,
  }),
  miami: def('miami', {
    name: 'Miami International Autodrome', place: 'Miami', country: 'United States', lengthKm: 5.412, round: 4,
    startBack: 580, flying: { drift: 110, lcgt3: 114, lcf1: 138 },
    // by hand: the rule's spot, before the hairpin (T17), is a 21 s run-up for the GT3
    startManual: 'out of the hairpin, before T18',
    pit: [-170, 190], stands: [6, 7],
    skyline: false, trees: 400, pitSide: 1,
    scene: 'city', flora: 'palm', hills: 0, light: 'high', sunAz: 230,
    buildings: { h: [8, 20], towers: 0.08, tower: 70, colors: [0xf2efe8, 0xe8dcc8, 0xd8e4e6, 0xf0e2d0, 0xc8d4dc], setback: 30 },
  }),
  montreal: def('montreal', {
    name: 'Circuit Gilles Villeneuve', place: 'Montreal', country: 'Canada', lengthKm: 4.361, round: 5,
    startBack: 705, flying: { drift: 221, lcgt3: 258, lcf1: 276 },
    pit: [-350, 20], stands: [13, 0],
    skyline: true, trees: 900, pitSide: -1,
    scene: 'park', hills: 70, light: 'clear', sunAz: 230,
  }),
  monaco: def('monaco', {
    name: 'Monaco', place: 'Monte Carlo', country: 'Monaco', lengthKm: 3.337, round: 6,
    startBack: 517, flying: { drift: 103, lcgt3: 105, lcf1: 125 },
    // by hand: the rule's spot, between the two Swimming Pool chicanes, is a 24 s run-up for the GT3
    startManual: 'out of the Swimming Pool, before La Rascasse (a gentle curve, radius 260 m or more)',
    pit: [-100, 20], stands: [1, 2],
    skyline: true, trees: 300, pitSide: -1, street: true,
    scene: 'city', flora: 'palm', hills: 450, light: 'clear', sunAz: 220,
    buildings: { h: [16, 42], towers: 0.25, tower: 90, colors: [0xf0d9b5, 0xe8c4a8, 0xf2e6cf, 0xd9a98c, 0xe6dcc8, 0xc9b79c] },
  }),
  barcelona: def('barcelona', {
    name: 'Barcelona-Catalunya', place: 'Montmeló', country: 'Spain', lengthKm: 4.657, round: 7,
    startBack: 584, flying: { drift: 154, lcgt3: 162, lcf1: 181 },
    pit: [-300, 300], stands: [12, 12],
    skyline: false, trees: 900, pitSide: -1,
    scene: 'dry', flora: 'mixed', hills: 280, light: 'high', sunAz: 225,
  }),
  spielberg: def('spielberg', {
    name: 'Red Bull Ring', place: 'Spielberg', country: 'Austria', lengthKm: 4.318, round: 8,
    startBack: 448, flying: { drift: 133, lcgt3: 146, lcf1: 181 },
    pit: [-180, 300], stands: [6, 12],
    skyline: false, trees: 3500, pitSide: -1,
    scene: 'forest', flora: 'conifer', hills: 700, light: 'clear', sunAz: 225,
  }),
  // Grand Prix layout, the line on the Hamilton Straight just after Club: only ~75 m of straight before it, so the
  // buildings sit further forward. A former airfield in open country: no skyline, fewer trees,
  // and the pit complex on the inside (right) of the straight.
  silverstone: def('silverstone', {
    name: 'Silverstone', place: 'England', country: 'United Kingdom', lengthKm: 5.891, round: 9,
    startBack: 550, flying: { drift: 187, lcgt3: 194, lcf1: 216 },
    pit: [-60, 240], stands: [3, 13],
    skyline: false, trees: 900, pitSide: -1,
    scene: 'country', hills: 15, light: 'northern', sunAz: 225,
  }),
  spa: def('spa', {
    name: 'Spa-Francorchamps', place: 'Stavelot', country: 'Belgium', lengthKm: 7.004, round: 10,
    startBack: 464, flying: { drift: 204, lcgt3: 224, lcf1: 238 },
    pit: [-140, 300], stands: [5, 12],
    skyline: false, trees: 5000, pitSide: -1,
    scene: 'forest', flora: 'conifer', hills: 220, light: 'northern', sunAz: 230,
  }),
  hungaroring: def('hungaroring', {
    name: 'Hungaroring', place: 'Budapest', country: 'Hungary', lengthKm: 4.381, round: 11,
    startBack: 460, flying: { drift: 128, lcgt3: 138, lcf1: 171 },
    pit: [-150, 350], stands: [5, 14],
    skyline: false, trees: 1200, pitSide: -1,
    scene: 'dry', hills: 110, light: 'haze', sunAz: 235,
  }),
  zandvoort: def('zandvoort', {
    name: 'Zandvoort', place: 'Zandvoort', country: 'Netherlands', lengthKm: 4.259, round: 12,
    startBack: 591, flying: { drift: 125, lcgt3: 133, lcf1: 160 },
    pit: [-250, 250], stands: [10, 12],
    skyline: false, trees: 1500, pitSide: 1,
    scene: 'dunes', flora: 'scrub', hills: 30, light: 'northern', sunAz: 230,
  }),
  monza: def('monza', {
    name: 'Monza', place: 'Monza', country: 'Italy', lengthKm: 5.793, round: 13,
    startBack: 880, flying: { drift: 221, lcgt3: 258, lcf1: 273 },
    pit: [-150, 250], stands: [10, 16],
    skyline: false, trees: 4000, pitSide: -1,
    scene: 'forest', hills: 15, light: 'haze', sunAz: 230,
  }),
  madrid: def('madrid', {
    name: 'Madring', place: 'Madrid', country: 'Spain', lengthKm: 5.414, round: 14,
    startBack: 568, flying: { drift: 168, lcgt3: 165, lcf1: 201 },
    pit: [-300, 140], stands: [12, 5],
    skyline: true, trees: 300, pitSide: -1,
    scene: 'city', hills: 150, light: 'clear', sunAz: 235,
    buildings: { h: [10, 24], towers: 0.12, tower: 110, colors: [0xd8d4cc, 0xc4c8cc, 0xe0d8c8, 0xa8b0b8], setback: 20 },
  }),
  baku: def('baku', {
    name: 'Baku City Circuit', place: 'Baku', country: 'Azerbaijan', lengthKm: 6.003, round: 15,
    startBack: 1180, flying: { drift: 187, lcgt3: 192, lcf1: 224 },
    // by hand: the last corner of radius 150 m or less is 1.4 km back (a 28 s run-up for the GT3)
    startManual: 'before the last corner the cars brake for; the kinks after it to the line are flat out',
    pit: [-400, 120], stands: [14, 4],
    skyline: true, trees: 300, pitSide: 1, street: true,
    scene: 'city', flora: 'palm', hills: 80, light: 'golden', sunAz: 235,
    buildings: { h: [14, 34], towers: 0.15, tower: 110, colors: [0xd9c39a, 0xcbb084, 0xe2d2ae, 0xbfa77e, 0xd8ccb4], setback: 6 },
  }),
  singapore: def('singapore', {
    name: 'Marina Bay', place: 'Singapore', country: 'Singapore', lengthKm: 4.927, round: 16,
    startBack: 648, flying: { drift: 169, lcgt3: 168, lcf1: 208 },
    pit: [-300, 80], stands: [12, 3],
    skyline: true, trees: 600, pitSide: 1, street: true,
    scene: 'city', flora: 'palm', hills: 0, light: 'night', sunAz: 240,
    buildings: { h: [20, 55], towers: 0.4, tower: 180, colors: [0x8fa9b8, 0x6f8a9a, 0xb8c4cc, 0xd8dcd8, 0x5f7a8c], signs: true, setback: 8 },
  }),
  austin: def('austin', {
    name: 'Circuit of the Americas', place: 'Austin', country: 'United States', lengthKm: 5.513, round: 17,
    startBack: 303, flying: { drift: 169, lcgt3: 168, lcf1: 199 },
    pit: [-100, 400], stands: [4, 14],
    skyline: false, trees: 500, pitSide: 1,
    scene: 'dry', hills: 60, light: 'golden', sunAz: 230,
  }),
  mexico: def('mexico', {
    name: 'Autódromo Hermanos Rodríguez', place: 'Mexico City', country: 'Mexico', lengthKm: 4.304, round: 18,
    startBack: 556, flying: { drift: 103, lcgt3: 117, lcf1: 139 },
    // by hand: the rule's spot, before the stadium, is a 25 s run-up for the GT3
    startManual: 'in the stadium, on the short straight before its last corners',
    pit: [-250, 500], stands: [9, 18],
    skyline: true, trees: 600, pitSide: -1,
    scene: 'park', hills: 600, light: 'high', sunAz: 205,
  }),
  saopaulo: def('saopaulo', {
    name: 'Interlagos', place: 'São Paulo', country: 'Brazil', lengthKm: 4.309, round: 19,
    startBack: 752, flying: { drift: 166, lcgt3: 184, lcf1: 205 },
    pit: [-200, 250], stands: [7, 9],
    skyline: true, trees: 900, pitSide: 1,
    scene: 'park', hills: 120, light: 'high', sunAz: 300,
  }),
  lasvegas: def('lasvegas', {
    name: 'Las Vegas Strip Circuit', place: 'Las Vegas', country: 'United States', lengthKm: 6.201, round: 20,
    startBack: 468, flying: { drift: 219, lcgt3: 250, lcf1: 269 },
    pit: [-200, 70], stands: [7, 2],
    skyline: true, trees: 300, pitSide: 1, street: true,
    scene: 'city', flora: 'palm', hills: 900, light: 'night', sunAz: 240,
    buildings: { h: [25, 70], towers: 0.5, tower: 160, colors: [0xe8dcc0, 0xd6b47a, 0xc9ccd2, 0xf2ece0, 0x8a9aa8], signs: true, setback: 22 },
  }),
  lusail: def('lusail', {
    name: 'Lusail International Circuit', place: 'Lusail', country: 'Qatar', lengthKm: 5.419, round: 21,
    startBack: 891, flying: { drift: 190, lcgt3: 200, lcf1: 228 },
    pit: [-400, 380], stands: [15, 14],
    skyline: true, trees: 350, pitSide: -1,
    scene: 'desert', flora: 'palm', hills: 10, light: 'night', sunAz: 240,
  }),
  yasmarina: def('yasmarina', {
    name: 'Yas Marina', place: 'Abu Dhabi', country: 'United Arab Emirates', lengthKm: 5.281, round: 22,
    startBack: 431, flying: { drift: 139, lcgt3: 143, lcf1: 176 },
    pit: [-230, 200], stands: [9, 8],
    skyline: false, trees: 500, pitSide: 1,
    scene: 'desert', flora: 'palm', hills: 10, light: 'dusk', sunAz: 245,
  }),
  // On the 2026 calendar as published, then cancelled (no round).
  bahrain: def('bahrain', {
    name: 'Bahrain International Circuit', place: 'Sakhir', country: 'Bahrain', lengthKm: 5.412,
    startBack: 714, flying: { drift: 215, lcgt3: 239, lcf1: 261 },
    pit: [-300, 400], stands: [12, 15],
    skyline: false, trees: 700, pitSide: -1,
    scene: 'desert', flora: 'scrub', hills: 30, light: 'night', sunAz: 240,
  }),
  jeddah: def('jeddah', {
    name: 'Jeddah Corniche Circuit', place: 'Jeddah', country: 'Saudi Arabia', lengthKm: 6.174,
    startBack: 922, flying: { drift: 201, lcgt3: 257, lcf1: 250 },
    pit: [-350, 300], stands: [15, 13],
    skyline: true, trees: 300, pitSide: 1, street: true,
    scene: 'city', flora: 'palm', hills: 15, light: 'night', sunAz: 245,
    buildings: { h: [10, 28], towers: 0.15, tower: 120, colors: [0xf2eee6, 0xe6dcc8, 0xd8d0c0, 0xc8ccd0], signs: true, setback: 14 },
  }),
};

// The circuit's CSV text. Each is its own small chunk in the build, fetched only for the circuit being driven.
const CSV = import.meta.glob<string>('../tracks/*.csv', { query: '?raw', import: 'default' });
export function loadTrackCsv(id: TrackId): Promise<string> {
  const load = CSV[`../tracks/${id}.csv`];
  if (!load) throw new Error(`no tracks/${id}.csv`);
  return load();
}
