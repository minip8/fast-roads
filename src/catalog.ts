import { parseCSV } from './track';
import { TRACKS, type TrackDef, type TrackId } from './tracks';

// ============================================================================
// What the menu shows about each circuit: its name and place, length, and an outline drawn from its centreline.
// Built from TRACKS alone, so a new circuit shows up by itself. Optional metadata a TrackDef may carry (country,
// lengthKm) is read if present.
// ============================================================================
export interface CircuitInfo {
  id: TrackId;
  name: string;
  place: string;          // "Melbourne", or "Melbourne, Australia" when the def has a country that isn't its place
  lengthKm: number;
  outline: string;        // SVG path in a 100 x 100 box, the same way up as the minimap (north up)
  start: [x: number, y: number];   // the start/finish line on that outline
  search: string;         // lower-case text the circuit search matches against
}

type OptionalMeta = { country?: unknown; lengthKm?: unknown };

const cache = new Map<TrackId, CircuitInfo>();

export function circuitInfo(def: TrackDef): CircuitInfo {
  const hit = cache.get(def.id);
  if (hit) return hit;
  const meta = def as TrackDef & OptionalMeta;
  const pts = parseCSV(def.csv);
  let len = 0, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    len += Math.hypot(q.x - p.x, q.z - p.z);
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const span = Math.max(maxX - minX, maxZ - minZ) || 1, pad = 6, sc = (100 - 2 * pad) / span;
  const ox = pad + ((span - (maxX - minX)) * sc) / 2, oz = pad + ((span - (maxZ - minZ)) * sc) / 2;
  const at = (k: number): [number, number] => [+(ox + (pts[k].x - minX) * sc).toFixed(1), +(oz + (pts[k].z - minZ) * sc).toFixed(1)];
  const step = Math.max(1, Math.floor(pts.length / 240));
  let d = '';
  for (let k = 0; k < pts.length; k += step) { const [x, y] = at(k); d += (k ? 'L' : 'M') + x + ' ' + y; }
  const country = typeof meta.country === 'string' && meta.country !== def.place ? meta.country : '';
  const lengthKm = typeof meta.lengthKm === 'number' && meta.lengthKm > 0 ? meta.lengthKm : len / 1000;
  const info: CircuitInfo = {
    id: def.id, name: def.name, place: country ? `${def.place}, ${country}` : def.place, lengthKm,
    outline: d + 'Z', start: at(0), search: [def.name, def.place, country].join(' ').toLowerCase(),
  };
  cache.set(def.id, info);
  return info;
}

export const allCircuits = () => (Object.values(TRACKS) as TrackDef[]).map(circuitInfo);
