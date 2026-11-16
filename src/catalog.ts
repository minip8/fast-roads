import { TRACKS, type TrackDef, type TrackId } from './tracks';
import { OUTLINES } from './trackOutlines';

// ============================================================================
// What the menu shows about each circuit: its name and place, length, and an outline of its centreline.
// Built from TRACKS alone, so a new circuit shows up by itself. The outlines are in trackOutlines.ts (generated:
// npm run tracks:outlines), because only the circuit being driven has its CSV loaded.
// ============================================================================
export interface CircuitInfo {
  id: TrackId;
  name: string;
  place: string;          // "Melbourne, Australia" (just the place when the country is the same word)
  lengthKm: number;
  outline: string;        // SVG path in a 100 x 100 box, the same way up as the minimap (north up)
  start: [x: number, y: number];   // the start/finish line on that outline
  search: string;         // lower-case text the circuit search matches against
}

export interface Outline { path: string; start: [x: number, y: number] }

// A centreline as an SVG path of about 120 points, centred in a 100 x 100 box.
export function outlineOf(pts: { x: number; z: number }[]): Outline {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
  const span = Math.max(maxX - minX, maxZ - minZ) || 1, pad = 6, sc = (100 - 2 * pad) / span;
  const ox = pad + ((span - (maxX - minX)) * sc) / 2, oz = pad + ((span - (maxZ - minZ)) * sc) / 2;
  const at = (k: number): [number, number] => [+(ox + (pts[k].x - minX) * sc).toFixed(1), +(oz + (pts[k].z - minZ) * sc).toFixed(1)];
  const step = Math.max(1, Math.floor(pts.length / 120));
  let d = '';
  for (let k = 0; k < pts.length; k += step) { const [x, y] = at(k); d += (k ? 'L' : 'M') + x + ' ' + y; }
  return { path: d + 'Z', start: at(0) };
}

const cache = new Map<TrackId, CircuitInfo>();

export function circuitInfo(def: TrackDef): CircuitInfo {
  const hit = cache.get(def.id);
  if (hit) return hit;
  const country = def.country !== def.place ? def.country : '';
  const { path, start } = OUTLINES[def.id];
  const info: CircuitInfo = {
    id: def.id, name: def.name, place: country ? `${def.place}, ${country}` : def.place, lengthKm: def.lengthKm,
    outline: path, start, search: [def.name, def.place, country].join(' ').toLowerCase(),
  };
  cache.set(def.id, info);
  return info;
}

export const allCircuits = () => (Object.values(TRACKS) as TrackDef[]).map(circuitInfo);
