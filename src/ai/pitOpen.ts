import { inPitLane, type Track } from '../track';
import { dilate } from '../util';

// ============================================================================
// Where the pit lane is open to the track, for the observation: per track sample and side, whether the lane's road
// adjoins the track's edge there with nothing between, so that a car leaving the road on that side would be in the
// pit lane (Timing's PIT LANE rule: inPitLane, the car's centre on the lane's road and off the track's) and its lap
// deleted. That is the lane's entry before the pit wall's nose and its exit after the tail (pitLane.ts). From the nose
// to the tail the lane is behind the pit wall, which the observation's wall_left / wall_right already read as the
// barrier on that side; there it is not flagged (nothing drives into it from the track).
//   Built once per track (lazily, kept with it) by asking inPitLane itself, so it says exactly what the timing will:
// sample i, side L / R is set if any of a few points near it, from just past the edge to 3 m beyond, is in the pit lane
// on its open stretch and in front of the track's barrier. The points cover the sample's share of the centreline (1 m
// either way: samples are about 2 m apart), and the flags are then grown by one sample each way: at a stretch's ends
// the lane's road can begin between the points (a sliver at the pit wall's tail, or closer to the edge than the
// first point), and a car centre there has a neighbouring sample nearest. test/ai-pit.test.ts checks every circuit
// against a far finer search out to 12 m (none missed: where the lane's road reaches deeper it also reaches within
// 3 m). Nothing more: the look-ahead samples show a stretch coming.
// ============================================================================
export interface PitOpen { left: Uint8Array; right: Uint8Array }

export const PIT_OPEN_PAST = [0.05, 0.5, 1, 1.5, 2, 2.5, 3];   // m past the track's edge
const ALONG = [-1, -0.5, 0, 0.5, 1];                            // m along the track from the sample

const cache = new WeakMap<Track, PitOpen>();
export function pitOpen(tr: Track): PitOpen {
  let o = cache.get(tr);
  if (!o) cache.set(tr, (o = buildPitOpen(tr)));
  return o;
}

function buildPitOpen(tr: Track): PitOpen {
  const N = tr.N, left = new Uint8Array(N), right = new Uint8Array(N), l = tr.pit;
  if (!l) return { left, right };
  const at = { d: 0 };
  for (const side of [1, -1] as const) {
    const flag = side > 0 ? left : right, W = side > 0 ? tr.WL : tr.WR;
    const bar = side > 0 ? tr.barL : tr.barR, valid = side > 0 ? tr.barLValid : tr.barRValid;
    for (let i = 0; i < N; i++) {
      const nx = side * tr.NX[i], nz = side * tr.NZ[i];
      test: for (const u of ALONG) {
        const cx = tr.X[i] + tr.TX[i] * u, cz = tr.Z[i] + tr.TZ[i] * u;
        for (const o of PIT_OPEN_PAST) {
          const off = W[i] + o;
          if (valid[i] && off >= bar[i]) break;   // (behind the barrier: not reachable from here)
          if (inPitLane(tr, cx + nx * off, cz + nz * off, i, at) && (at.d < l.nose || at.d > l.tail)) { flag[i] = 1; break test; }
        }
      }
    }
  }
  return { left: dilate(left, 1, 1), right: dilate(right, 1, 1) };
}
