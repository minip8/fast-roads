import { buildPitLane, csvLapLength, fitBarrier, parsePitCsv } from './pitLane';
import { buildTrack, parseCSV, type Track } from './track';
import { loadPitCsv, loadTrackCsv, type TrackDef } from './tracks';

// ============================================================================
// A circuit as every mode drives it: the track (track.ts) from its centreline CSV, with its real pit lane
// (pitLane.ts) from tracks/pits/<id>.csv, the track's barrier on that side fitted round the lane.
// ============================================================================
export function buildCircuit(csv: string, pitCsv: string, def: Pick<TrackDef, 'street' | 'pit' | 'pitSide' | 'pitCut'>): Track {
  const raw = parseCSV(csv), tr = buildTrack(raw, { street: def.street });
  const lane = buildPitLane(tr, parsePitCsv(pitCsv), { side: def.pitSide, work: def.pit, sScale: tr.L / csvLapLength(raw), cut: def.pitCut });
  fitBarrier(tr, lane);
  tr.pit = lane;
  return tr;
}

// The circuit's two CSVs, fetched (each its own chunk in the build), then built.
export async function loadCircuit(def: TrackDef): Promise<Track> {
  const [csv, pit] = await Promise.all([loadTrackCsv(def.id), loadPitCsv(def.id)]);
  return buildCircuit(csv, pit, def);
}
