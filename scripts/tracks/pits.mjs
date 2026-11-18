// Makes the pit lanes in tracks/pits/ from OpenStreetMap: for each circuit, the real pit lane's centreline in the
// coordinate frame of that circuit's tracks/<id>.csv, and tracks/pits/index.json, a summary of every lane.
//
// Source: OpenStreetMap (© OpenStreetMap contributors, ODbL 1.0: openstreetmap.org/copyright), through the Overpass
// API. Each circuit is a `type=circuit` relation (or plain `highway=raceway` ways); its pit lane is the relation's
// `pit_lane` member, or ways tagged as one (raceway=pit_lane, service=pit_lane, a "Pit Lane" name...); what exactly
// is used is in each circuit's CIRCUITS entry below, and each output file names its OSM ways.
//
// Registration: our centrelines are in local metres with their own origin (the TUM ones were made from their own
// survey and smoothed), so OSM's lon/lat is projected to a tangent plane (as convert.mjs does), the OSM circuit is
// fitted to our centreline (rotation + translation, no scale: a coarse rotation search against the bacinger/f1-circuits
// centreline of the same circuit, which is a single clean loop, then trimmed ICP against the OSM circuit's ways),
// and that transform is applied to the pit lane. The fit's residual (distance from each of our centreline rows to
// the registered OSM circuit) is reported per circuit.
//
// Where OSM has no usable pit lane, CIRCUITS[id].approx describes one by hand (side, where it leaves and rejoins,
// how far out it runs) and the lane is a smooth offset path from our own centreline, marked `approx` everywhere.
// (In the November 2026 data every circuit has its lane in OSM, so none is approx.)
//
// Look at the result: --svg draws our track, the registered OSM circuit, the lane, the start line and today's pit
// building (TrackDef.pit / pitSide) for each circuit.
//
//   node scripts/tracks/pits.mjs fetch <cache> [id ...]               # one Overpass query per circuit, cached as <cache>/<id>.json
//   node scripts/tracks/pits.mjs build <cache> <f1-circuits> [--svg <dir>] [id ...]
//                                                                   # writes tracks/pits/<id>.csv and tracks/pits/index.json;
//                                                                   # --svg also draws each circuit to <dir>/<id>.svg (+ .png with sharp)
//   git clone --depth 1 https://github.com/bacinger/f1-circuits.git <f1-circuits>
//
// The game builds each circuit's pit lane from these files (src/pitLane.ts, through tracks.ts loadPitCsv): the rows'
// x/y as the lane's path and their s to unwrap its lap position (which it then takes from its own projection where
// the lane runs beside the track); index.json's working stretch and side became TrackDef.pit / pitSide by hand, and
// the game reads nothing else from it.
//
// Output tracks/pits/<id>.csv (not tracks/*.csv: loadTrackCsv's glob and the tests read only those):
//   # comment lines (source, OSM ways, transform, quality)
//   x_m,y_m,s_m,lat_m[,w_m]   rows about 5 m apart in the racing direction, from where the lane leaves the circuit
//                             (the junction on the racing line, inside the track) to where it rejoins it.
//   x_m, y_m: in the frame of tracks/<id>.csv (x east, y north, m). s_m: metres along our centreline (the CSV rows as a
//   closed polyline, from row 0 at the line) of the nearest point, lat_m: signed distance from it (+ = left in the
//   racing direction), both found near the lane's own stretch of the lap (so a lane passing another part of the lap
//   still reads its own). w_m: the lane's full width, only where OSM tags one (`width`).
// The game resamples the centreline (track.ts: Catmull-Rom, ~2 m, light smoothing), so its S differs from s_m by
// a fraction of a metre per km; project x/y with projectOnTrack for exact values.
//
// tracks/pits/index.json, per circuit (s: m along our lap from the line, 0..L; sFromLine: the same, negative before
// the line, as TrackDef.pit; row: nearest 0-based data row of tracks/<id>.csv; lat/edge: m from our centreline):
//   quality 'osm' | 'approx'; side 'left' | 'right' (sideSign +1 | -1, as TrackDef.pitSide) where most of the lane is;
//   entry / exit: the lane's first and last rows (where it meets the circuit); leavesTrack / rejoinsTrack: the first
//   and last rows beyond our track's edge; length_m, lapSpan_m, maxOffset_m (+ where); working: the stretch beside
//   the garages, from OSM's pit buildings or else inferred (the longest stretch at a steady distance: rough);
//   crossesTrack: the lane passing over or under its own stretch (from / to side, OSM tunnel or bridge tag);
//   farFromTrack: stretches 20 m+ beyond the edge (cutting inside a corner); otherPartOfLap: rows on another part
//   of the lap's road or inside its walls; today: TrackDef.pit / pitSide and the overlap with the working stretch;
//   checks; registration (residuals: all rows, and only where OSM maps the circuit within 10 m); osm (ways, data
//   date); notes. The script prints a line per circuit with anything odd.
import fs from 'node:fs';
import path from 'node:path';

const SPACING = 5;
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '../..');
const outDir = path.join(root, 'tracks/pits');

// bbox: [south, west, north, east] of the circuit (from bacinger/f1-circuits), queried with PAD degrees round it.
// geo: the bacinger/f1-circuits file of the same circuit (the initial registration).
// rel: the OSM circuit relation to fit and take the pit lane from (else every relation/raceway way is tried).
// pit: OSM way ids of the pit lane, in any order (else the relation's pit_lane members, else tagged ways).
// approx: no usable OSM lane; { side: 1 left | -1 right, from: s, to: s (m along our lap, from the line; from may
//   be negative: before the line), out: m from our centreline at its widest, ramp: m to swing out/in, why }.
// note: anything odd, copied into index.json.
const CIRCUITS = {
  melbourne: { geo: 'au-1953', bbox: [-37.8539, 144.9621, -37.838, 144.9786] },
  shanghai: { geo: 'cn-2004', bbox: [31.3358, 121.215, 31.3455, 121.2279] },
  suzuka: { geo: 'jp-1962', bbox: [34.839, 136.5219, 34.8484, 136.5434] },
  miami: { geo: 'us-2022', bbox: [25.9552, -80.2448, 25.9606, -80.2298] },
  montreal: { geo: 'ca-1978', bbox: [45.4971, -73.5299, 45.5143, -73.5219] },
  monaco: { geo: 'mc-1929', bbox: [43.7324, 7.4212, 43.7411, 7.4304] },
  barcelona: { geo: 'es-1991', bbox: [41.5642, 2.2521, 41.5748, 2.2637] },
  spielberg: { geo: 'at-1969', bbox: [47.2193, 14.7541, 47.2264, 14.7706] },
  silverstone: { geo: 'gb-1948', bbox: [52.0635, -1.0243, 52.0789, -1.0093] },
  spa: { geo: 'be-1925', bbox: [50.4277, 5.9596, 50.4462, 5.9776] },
  hungaroring: { geo: 'hu-1986', bbox: [47.5776, 19.2423, 47.5885, 19.2566] },
  zandvoort: { geo: 'nl-1948', bbox: [52.3844, 4.5387, 52.3918, 4.5531] },
  monza: { geo: 'it-1922', bbox: [45.6119, 9.2807, 45.6314, 9.2969] },
  madrid: { geo: 'es-2026', bbox: [40.4643, -3.6253, 40.4806, -3.612] },
  baku: { geo: 'az-2016', bbox: [40.3625, 49.8309, 40.3761, 49.8552] },
  singapore: { geo: 'sg-2008', bbox: [1.2866, 103.8516, 1.2949, 103.8644] },
  austin: { geo: 'us-2012', bbox: [30.13, -97.6435, 30.1395, -97.6245] },
  mexico: { geo: 'mx-1962', bbox: [19.397, -99.0969, 19.4064, -99.0831] },
  saopaulo: { geo: 'br-1940', bbox: [-23.7064, -46.7005, -23.697, -46.694] },
  lasvegas: { geo: 'us-2023', bbox: [36.1079, -115.1732, 36.1255, -115.1601] },
  lusail: { geo: 'qa-2004', bbox: [25.4838, 51.4475, 25.4971, 51.46], pit: [1037707300, 196193732],
    note: 'OSM has two entries into the pit lane (MotoGP and F1): the F1 one (way 1037707300) is used' },
  yasmarina: { geo: 'ae-2009', bbox: [24.4632, 54.6016, 24.4786, 54.6096] },
  bahrain: { geo: 'bh-2002', bbox: [26.0261, 50.5103, 26.0369, 50.5184] },
  jeddah: { geo: 'sa-2021', bbox: [21.6254, 39.1009, 21.6501, 39.1066] },
};
const PAD = 0.003;
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const UA = 'pit-lane-data-script/1.0';

// ---------------------------------------------------------------------------------------------------- fetch
function query([s, w, n, e]) {
  const b = [s - PAD, w - PAD, n + PAD, e + PAD].map((v) => v.toFixed(4)).join(',');
  return `[out:json][timeout:180];
(rel["type"="circuit"](${b}); rel["highway"="raceway"](${b});)->.rels;
(way(r.rels);
 way["highway"="raceway"](${b});
 way["raceway"](${b});
 way["name"~"pit|boxengasse",i](${b});
 way["service"~"pit",i](${b});
 way["building"]["name"~"pit|box",i](${b});
 way["building"]["addr:unit"~"pit",i](${b});
)->.ways;
.rels out body;
.ways out body geom;`;
}

async function fetchAll(cache, only) {
  fs.mkdirSync(cache, { recursive: true });
  for (const [id, c] of Object.entries(CIRCUITS)) {
    if (only.length && !only.includes(id)) continue;
    const file = path.join(cache, `${id}.json`);
    if (fs.existsSync(file)) { console.log(`${id}: cached`); continue; }
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(OVERPASS, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(query(c.bbox)) });
      if (res.ok) { const t = await res.text(); JSON.parse(t); fs.writeFileSync(file, t); console.log(`${id}: ${t.length} bytes`); break; }
      console.log(`${id}: HTTP ${res.status}, retrying`);
      if (attempt > 8) throw new Error(`${id}: giving up`);
      await new Promise((r) => setTimeout(r, 20000 * 2 ** Math.min(attempt, 4)));   // back off (429 / 504 / 502)
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// ---------------------------------------------------------------------------------------------------- geometry
function projector([s, w, n, e]) {
  const lat0 = (s + n) / 2, lon0 = (w + e) / 2;
  const a = 6378137, e2 = 6.69437999014e-3, rad = Math.PI / 180, sl = Math.sin(lat0 * rad), q = 1 - e2 * sl * sl;
  const M = (a * (1 - e2)) / Math.pow(q, 1.5), Nr = a / Math.sqrt(q);
  return (lat, lon) => [(lon - lon0) * rad * Nr * Math.cos(lat0 * rad), (lat - lat0) * rad * M];
}
const hyp = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const polyLen = (P) => { let L = 0; for (let i = 1; i < P.length; i++) L += hyp(P[i - 1], P[i]); return L; };

function readOurs(id) {
  const rows = fs.readFileSync(path.join(root, 'tracks', `${id}.csv`), 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && l[0] !== '#').map((l) => l.split(',').map(Number));
  const P = rows.map((r) => [r[0], r[1]]), N = P.length;
  const S = [0];
  for (let i = 0; i < N; i++) S.push(S[i] + hyp(P[i], P[(i + 1) % N]));
  return { P, N, S, L: S[N], wr: rows.map((r) => r[2]), wl: rows.map((r) => r[3]) };
}
const wrapS = (s, L) => ((s % L) + L) % L;
// signed circular difference b - a in (-L/2, L/2]
const dS = (a, b, L) => { let d = wrapS(b - a, L); if (d > L / 2) d -= L; return d; };

// Nearest point of our centreline (closed polyline) to p, optionally only where s is from `back` m before sNear to `fwd` m after it.
function project(tr, p, sNear, back, fwd = back) {
  let best = { d: Infinity };
  for (let i = 0; i < tr.N; i++) {
    const a = tr.P[i], b = tr.P[(i + 1) % tr.N], ux = b[0] - a[0], uy = b[1] - a[1], l2 = ux * ux + uy * uy || 1e-9;
    let f = ((p[0] - a[0]) * ux + (p[1] - a[1]) * uy) / l2;
    f = Math.max(0, Math.min(1, f));
    const s = tr.S[i] + f * (tr.S[i + 1] - tr.S[i]);
    if (back !== undefined) { const ds = dS(sNear, s, tr.L); if (ds < -back || ds > fwd) continue; }
    const qx = a[0] + ux * f, qy = a[1] + uy * f, d = Math.hypot(p[0] - qx, p[1] - qy);
    if (d < best.d) {
      const l = Math.sqrt(l2), lat = (ux * (p[1] - a[1]) - uy * (p[0] - a[0])) / l;
      const wl = tr.wl[i] + f * (tr.wl[(i + 1) % tr.N] - tr.wl[i]), wr = tr.wr[i] + f * (tr.wr[(i + 1) % tr.N] - tr.wr[i]);
      best = { d, i: f < 0.5 ? i : (i + 1) % tr.N, s, lat, wl, wr, edge: lat >= 0 ? wl : wr };
    }
  }
  return best;
}
// our centreline at s (+ lat to the left)
function pointAt(tr, s, lat = 0) {
  s = wrapS(s, tr.L);
  let i = 0;
  while (tr.S[i + 1] < s) i++;
  const a = tr.P[i], b = tr.P[(i + 1) % tr.N], l = tr.S[i + 1] - tr.S[i] || 1, f = (s - tr.S[i]) / l;
  const ux = (b[0] - a[0]) / l, uy = (b[1] - a[1]) / l;
  return [a[0] + (b[0] - a[0]) * f - uy * lat, a[1] + (b[1] - a[1]) * f + ux * lat];
}

// points of polylines every `step` m (for nearest-neighbour lookups)
function densify(lines, step) {
  const out = [];
  for (const P of lines) for (let i = 0; i + 1 < P.length; i++) {
    const n = Math.max(1, Math.ceil(hyp(P[i], P[i + 1]) / step));
    for (let k = 0; k < n; k++) out.push([P[i][0] + ((P[i + 1][0] - P[i][0]) * k) / n, P[i][1] + ((P[i + 1][1] - P[i][1]) * k) / n]);
    if (i + 2 === P.length) out.push(P[i + 1]);
  }
  return out;
}
class Grid {
  constructor(pts, cell = 10) {
    this.c = cell; this.m = new Map(); this.pts = pts;
    pts.forEach((p, k) => { const key = this.key(Math.floor(p[0] / cell), Math.floor(p[1] / cell)); (this.m.get(key) ?? this.m.set(key, []).get(key)).push(k); });
  }
  key(i, j) { return i * 100003 + j; }
  nearest(x, y, maxR = 60) {
    const c = this.c, ci = Math.floor(x / c), cj = Math.floor(y / c);
    let bd = Infinity, bk = -1;
    for (let r = 0; r * c <= maxR + c; r++) {
      for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
        for (const k of this.m.get(this.key(i, j)) ?? []) { const p = this.pts[k], d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; bk = k; } }
      }
      if (bd <= r * c) break;
    }
    return bd <= maxR ? { d: bd, p: this.pts[bk] } : { d: Infinity, p: null };
  }
}

// rigid transform {c, s (cos/sin), tx, ty}: p -> R p + t
const apply = (T, p) => [T.c * p[0] - T.s * p[1] + T.tx, T.s * p[0] + T.c * p[1] + T.ty];
const inverse = (T) => ({ c: T.c, s: -T.s, tx: -(T.c * T.tx + T.s * T.ty), ty: -(-T.s * T.tx + T.c * T.ty) });
const rot = (th, tx = 0, ty = 0) => ({ c: Math.cos(th), s: Math.sin(th), tx, ty });
// least-squares rigid transform taking A[i] to B[i]
function procrustes(A, B) {
  const n = A.length; let ax = 0, ay = 0, bx = 0, by = 0;
  for (let i = 0; i < n; i++) { ax += A[i][0]; ay += A[i][1]; bx += B[i][0]; by += B[i][1]; }
  ax /= n; ay /= n; bx /= n; by /= n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const x1 = A[i][0] - ax, y1 = A[i][1] - ay, x2 = B[i][0] - bx, y2 = B[i][1] - by;
    sxx += x1 * x2 + y1 * y2; sxy += x1 * y2 - y1 * x2;
  }
  const th = Math.atan2(sxy, sxx), T = rot(th);
  const r = apply(T, [ax, ay]);
  T.tx = bx - r[0]; T.ty = by - r[1];
  return T;
}
// trimmed ICP: T maps `pts` onto the points of `grid`; pairs farther than the current cut-off are left out
function icp(pts, grid, T, cuts = [40, 25, 15, 10, 7, 5, 4, 4, 4, 4]) {
  for (const cut of cuts) for (let it = 0; it < 3; it++) {
    const A = [], B = [];
    for (const p of pts) { const q = apply(T, p), n = grid.nearest(q[0], q[1], cut); if (n.p) { A.push(p); B.push(n.p); } }
    if (A.length < 20) return null;
    T = procrustes(A, B);
  }
  return T;
}
function residual(pts, grid, T) {
  const d = pts.map((p) => { const q = apply(T, p); return Math.min(grid.nearest(q[0], q[1], 100).d, 100); }).sort((a, b) => a - b);
  const q = (f) => d[Math.min(d.length - 1, Math.floor(f * d.length))];
  const near = d.filter((v) => v <= 10);   // where OSM has the circuit mapped at all
  return { median: q(0.5), p95: q(0.95), max: d.at(-1), mean20: d.reduce((s, v) => s + Math.min(v, 20), 0) / d.length,
    coverage: near.length / d.length, nearMedian: near[Math.floor(near.length / 2)] ?? NaN, nearP95: near[Math.floor(near.length * 0.95)] ?? NaN };
}
// coarse: centroids together, every rotation, then ICP; the best by trimmed mean distance
function coarseFit(pts, grid, target) {
  const cen = (P) => [P.reduce((s, p) => s + p[0], 0) / P.length, P.reduce((s, p) => s + p[1], 0) / P.length];
  const c0 = cen(pts), c1 = cen(target), sub = pts.filter((_, k) => k % 4 === 0);
  let best = null;
  for (let deg = 0; deg < 360; deg += 3) {
    const T = rot((deg * Math.PI) / 180), r = apply(T, c0);
    T.tx = c1[0] - r[0]; T.ty = c1[1] - r[1];
    const score = residual(sub, grid, T).mean20;
    if (!best || score < best.score) best = { score, T };
  }
  return icp(pts, grid, best.T, [80, 50, 30, 20, 12, 8, 6]) ?? best.T;
}

// ---------------------------------------------------------------------------------------------------- OSM
const PIT_ROLE = /pit/i;
// a pit lane's name in the languages of the calendar (Pit Lane, Pitstraat, Boxenstraße, Voie des stands, Corsia box...)
const PIT_NAME = /(^|[^a-z])(pit ?lane|pits?|pit ?road|pit ?(straat|stra(ss|ß)e)|boxen(gasse|stra(ss|ß)e)|voie des stands|corsia (dei )?box|(calle|carril|v[ií]a) de boxes|boxutca)([^a-z]|$)/i;
const isPitWay = (t = {}) => /pit/i.test(t.raceway ?? '') || /pit/i.test(t.service ?? '') || t.pit_lane === 'yes' || t.pitlane === 'yes'
  || PIT_NAME.test(t.name ?? '') || PIT_NAME.test(t['name:en'] ?? '');
const isPitBuilding = (t = {}) => !!t.building && /(^|[^a-z])(pits?|pitgebouw|pit ?building|boxen|box(es)?|garages?)([^a-z]|$)/i.test(`${t.name ?? ''} ${t['addr:unit'] ?? ''} ${t.description ?? ''}`);

function loadOsm(file, proj) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ways = new Map(), rels = [];
  for (const e of j.elements) {
    if (e.type === 'way' && e.geometry) ways.set(e.id, { id: e.id, tags: e.tags ?? {}, nodes: e.nodes, P: e.geometry.map((g) => proj(g.lat, g.lon)) });
    if (e.type === 'relation') rels.push(e);
  }
  return { ways, rels, stamp: j.osm3s?.timestamp_osm_base };
}

// groups of ways that share nodes
function components(ws) {
  const out = [], seen = new Set();
  for (const w of ws) {
    if (seen.has(w)) continue;
    const comp = [w], nodes = new Set(w.nodes); seen.add(w);
    for (let grew = true; grew;) {
      grew = false;
      for (const x of ws) if (!seen.has(x) && x.nodes.some((n) => nodes.has(n))) { seen.add(x); comp.push(x); x.nodes.forEach((n) => nodes.add(n)); grew = true; }
    }
    out.push(comp);
  }
  return out;
}

// Join ways into one polyline by shared end nodes (any order, either direction); null if they do not make one
// chain: a node where three way ends meet (a branch), or a gap between free ends of more than maxGap m.
function chain(ws, maxGap = 30) {
  const ends = new Map();
  for (const w of ws) for (const n of [w.nodes[0], w.nodes.at(-1)]) ends.set(n, (ends.get(n) ?? 0) + 1);
  if ([...ends.values()].some((v) => v > 2)) return null;
  const parts = ws.map((w) => ({ nodes: [...w.nodes], P: [...w.P], ids: [w.id], way: w.P.map(() => w.id), gaps: 0 }));
  const flip = (X) => { X.nodes.reverse(); X.P.reverse(); X.way.reverse(); };
  while (parts.length > 1) {
    let best = null;
    for (let a = 0; a < parts.length; a++) for (let b = a + 1; b < parts.length; b++) {
      const A = parts[a], B = parts[b];
      for (const ae of [0, 1]) for (const be of [0, 1]) {   // which end of each (0 start, 1 end)
        const an = ae ? A.nodes.at(-1) : A.nodes[0], bn = be ? B.nodes.at(-1) : B.nodes[0];
        const shared = an === bn, gap = shared ? 0 : hyp(ae ? A.P.at(-1) : A.P[0], be ? B.P.at(-1) : B.P[0]);
        if (!best || gap < best.gap) best = { a, b, ae, be, gap, shared };
      }
    }
    if (best.gap > maxGap) return null;
    const A = parts[best.a], B = parts[best.b];
    if (!best.ae) flip(A);
    if (best.be) flip(B);
    const k = best.shared ? 1 : 0;
    A.nodes.push(...B.nodes.slice(k)); A.P.push(...B.P.slice(k)); A.way.push(...B.way.slice(k)); A.ids.push(...B.ids);
    A.gaps += B.gaps + (best.shared ? 0 : 1);
    parts.splice(best.b, 1);
  }
  return parts[0];
}

// every `step` m along the polyline P (both ends kept)
function resample(P, step) {
  const cum = [0];
  for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hyp(P[i - 1], P[i]));
  const L = cum.at(-1), n = Math.max(1, Math.round(L / step)), out = [];
  for (let k = 0, j = 0; k <= n; k++) {
    const s = (k * L) / n;
    while (j < P.length - 2 && cum[j + 1] < s) j++;
    const f = Math.min(1, (s - cum[j]) / (cum[j + 1] - cum[j] || 1));
    out.push({ p: [P[j][0] + (P[j + 1][0] - P[j][0]) * f, P[j][1] + (P[j + 1][1] - P[j][1]) * f], seg: j });
  }
  return out;
}

// today's TrackDef.pit / pitSide / street, read from src/tracks.ts
function trackDefs() {
  const src = fs.readFileSync(path.join(root, 'src/tracks.ts'), 'utf8'), out = {};
  for (const id of Object.keys(CIRCUITS)) {
    const m = src.match(new RegExp(`${id}: def\\('${id}', \\{([\\s\\S]*?)\\n  \\}\\)`));
    if (!m) throw new Error(`${id}: not in src/tracks.ts`);
    const pit = m[1].match(/pit: \[(-?\d+), (-?\d+)\]/), side = m[1].match(/pitSide: (-?1)/), name = m[1].match(/name: '([^']+)'/);
    out[id] = { pit: [+pit[1], +pit[2]], pitSide: +side[1], street: /street: true/.test(m[1]), name: name[1] };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- one circuit
const r1 = (v) => Math.round(v * 10) / 10;
const sSigned = (s, L) => (s > L / 2 ? s - L : s);

function register(id, c, tr, osm, proj, geoDir) {
  const loop = [...tr.P, tr.P[0]], ours = densify([loop], 2.5);
  const geo = JSON.parse(fs.readFileSync(path.join(geoDir, 'circuits', `${c.geo}.geojson`), 'utf8')).features[0].geometry.coordinates.map(([lon, lat]) => proj(lat, lon));
  const geoPts = densify([geo], 1);
  const T0 = coarseFit(ours, new Grid(geoPts), geoPts);
  // candidate OSM circuits: each circuit relation's ways, and every raceway way that is not a pit lane
  const cands = [];
  for (const r of osm.rels) {
    if (c.rel && r.id !== c.rel) continue;
    const ws = r.members.filter((m) => m.type === 'way' && !PIT_ROLE.test(m.role) && osm.ways.has(m.ref)).map((m) => osm.ways.get(m.ref));
    if (ws.length) cands.push({ label: `relation ${r.id}${r.tags?.name ? ` (${r.tags.name})` : ''}`, rel: r, ws });
  }
  if (!c.rel) {
    const ws = [...osm.ways.values()].filter((w) => w.tags.highway === 'raceway' && !isPitWay(w.tags) && !w.tags.building && !w.tags.area);
    if (ws.length) cands.push({ label: 'highway=raceway ways', ws });
  }
  let best = null;
  for (const cd of cands) {
    const grid = new Grid(densify(cd.ws.map((w) => w.P), 1));
    const T = icp(ours, grid, T0);
    if (!T) continue;
    const res = residual(ours, grid, T);
    if (!best || res.mean20 < best.res.mean20) best = { ...cd, T, res, grid };
  }
  const geoRes = residual(ours, new Grid(geoPts), T0);
  if (!best) return { T: inverse(T0), res: geoRes, label: `bacinger/f1-circuits ${c.geo} only (no OSM circuit)`, ws: [], geoRes };
  return { ...best, T: inverse(best.T), geoRes };   // T: OSM (projected) -> ours
}

function pitWays(c, osm, reg, tr) {
  if (c.pit) return { ws: c.pit.map((i) => osm.ways.get(i)).filter(Boolean), how: 'listed in pits.mjs' };
  const near = (w) => w.P.some((p) => project(tr, apply(reg.T, p)).d < 150);
  const fromRel = (r) => r.members.filter((m) => m.type === 'way' && PIT_ROLE.test(m.role) && osm.ways.has(m.ref)).map((m) => osm.ways.get(m.ref));
  if (reg.rel) { const ws = fromRel(reg.rel).filter(near); if (ws.length) return { ws, how: `relation ${reg.rel.id} role pit_lane` }; }
  for (const r of osm.rels) { const ws = fromRel(r).filter(near); if (ws.length) return { ws, how: `relation ${r.id} role pit_lane` }; }
  const ws = [...osm.ways.values()].filter((w) => isPitWay(w.tags) && !w.tags.building && !w.tags.area && !w.tags['area:highway']
    && w.tags.sport !== 'karting' && !/kart/i.test(w.tags.name ?? '') && near(w));
  return { ws, how: 'tagged as a pit lane' };
}

function analyse(id, tr, rows, def, opts) {
  const L = tr.L, n = rows.length;
  // own projection: walk from the end that is on the track (the lane may run between two parts of the lap, so the
  // middle's nearest point can be the wrong one), each row searched near its neighbour's s
  const glob = rows.map((r) => project(tr, r.p));
  const own = new Array(n);
  const k0 = glob[0].d - glob[0].edge <= glob[n - 1].d - glob[n - 1].edge ? 0 : n - 1;
  own[k0] = glob[k0];
  if (k0 === 0) for (let k = 1; k < n; k++) own[k] = project(tr, rows[k].p, own[k - 1].s, 40, 150);
  else for (let k = n - 2; k >= 0; k--) own[k] = project(tr, rows[k].p, own[k + 1].s, 150, 40);
  const sRel = own.map((o) => dS(own[0].s, o.s, L));   // m along the lap from the entry
  // where each row is: +1 beyond the left edge, -1 beyond the right one, 0 on the track; the lane's side is where
  // most of it is
  const where = own.map((o) => (o.lat > o.edge + 0.25 ? 1 : o.lat < -o.edge - 0.25 ? -1 : 0));
  let far = 0;
  own.forEach((o, k) => { if (Math.abs(o.lat) > Math.abs(own[far].lat)) far = k; });
  const side = Math.sign(where.reduce((a, v) => a + v, 0)) || Math.sign(own[far].lat) || 1;
  const outside = where.map((v) => v === side);
  const leave = where.findIndex((v) => v !== 0), rejoin = where.findLastIndex((v) => v !== 0);
  let inside = 0, wrongSide = 0, back = 0;
  for (let k = leave; k <= rejoin; k++) { if (!where[k]) inside++; if (where[k] === -side) wrongSide++; }
  for (let k = 1; k < n; k++) if (sRel[k] < sRel[k - 1] - 0.5) back++;
  // the lane crossing its own stretch of track (over or under it: Yas Marina's exit tunnel)
  const crossings = [];
  for (let k = leave, last = leave; k <= rejoin; k++) {
    if (!where[k]) continue;
    if (where[k] !== where[last]) {
      const tags = rows.slice(last, k + 1).map((r) => opts.wayTags?.get(r.way) ?? {});
      const tunnel = tags.some((t) => t.tunnel && t.tunnel !== 'no'), bridge = tags.some((t) => t.bridge && t.bridge !== 'no');
      crossings.push({ laneRows: [last, k], s: r1(own[Math.round((last + k) / 2)].s), sFromLine: r1(sSigned(own[Math.round((last + k) / 2)].s, L)),
        from: where[last] > 0 ? 'left' : 'right', to: where[k] > 0 ? 'left' : 'right', how: tunnel ? 'tunnel (OSM)' : bridge ? 'bridge (OSM)' : 'at grade or untagged' });
    }
    last = k;
  }
  // another part of the lap (not this stretch: more than 60 m along the lap from the lane's own projection)
  const other = [], WALL = def.street ? 3.5 : 7;
  for (let k = 0; k < n; k++) {
    const g = glob[k];
    if (Math.abs(dS(own[k].s, g.s, L)) < 60) continue;
    const kind = g.d <= g.edge ? 'on its road' : g.d <= g.edge + WALL ? 'inside its walls' : null;
    if (kind) other.push({ row: k, s: r1(g.s), d: r1(g.d), kind });
  }
  const groups = [];
  for (const o of other) {
    const gp = groups.at(-1);
    if (gp && o.row - gp.toRow <= 2 && Math.abs(dS(gp.trackS[1], o.s, L)) < 30) { gp.toRow = o.row; gp.trackS[1] = o.s; gp.minD = Math.min(gp.minD, o.d); if (o.kind === 'on its road') gp.kind = o.kind; }
    else groups.push({ fromRow: o.row, toRow: o.row, trackS: [o.s, o.s], minD: o.d, kind: o.kind });
  }
  // working stretch: from the pit buildings if OSM has them, else the longest run parallel to the track at a
  // steady distance, outside its edge
  let working = null;
  if (opts.buildings?.length) {
    const ss = [];
    // each corner of a building that stands within 60 m of the lane, at the lap position of the nearest lane row
    for (const b of opts.buildings) for (const p of b) {
      let bk = -1, bd = 60;
      rows.forEach((r, k) => { const d = hyp(r.p, p); if (d < bd) { bd = d; bk = k; } });
      if (bk >= 0) ss.push(sRel[bk]);
    }
    if (ss.length) {
      const a = Math.max(Math.min(...ss), sRel[leave]), b = Math.min(Math.max(...ss), sRel[rejoin]);
      // only a row of garages (a single small building named "Box" or "Pit" says little)
      if (b - a >= 120) working = { from: r1(wrapS(own[0].s + a, L)), to: r1(wrapS(own[0].s + b, L)), source: 'OSM pit buildings' };
    }
  }
  if (!working) {
    let run = null, bestRun = null;
    for (let k = Math.max(1, leave); k <= rejoin; k++) {
      const steady = Math.abs(Math.abs(own[k].lat) - Math.abs(own[k - 1].lat)) < 0.35 && outside[k];
      if (steady) { run ??= { a: k - 1 }; run.b = k; if (!bestRun || run.b - run.a > bestRun.b - bestRun.a) bestRun = { ...run }; } else run = null;
    }
    if (bestRun) working = { from: r1(own[bestRun.a].s), to: r1(own[bestRun.b].s), source: 'inferred (longest stretch at a steady distance from the track)' };
  }
  // stretches where the lane is far (20 m+) beyond the track's edge: it cuts inside a corner or runs apart
  const farRuns = [];
  for (let k = 0; k < n; k++) {
    const beyond = side * own[k].lat - own[k].edge;
    if (beyond <= 20) continue;
    const fr = farRuns.at(-1);
    if (fr && fr.toRow === k - 1) { fr.toRow = k; fr.to = r1(own[k].s); fr.maxBeyondEdge_m = Math.max(fr.maxBeyondEdge_m, r1(beyond)); }
    else farRuns.push({ fromRow: k, toRow: k, from: r1(own[k].s), to: r1(own[k].s), maxBeyondEdge_m: r1(beyond) });
  }
  const len = polyLen(rows.map((r) => r.p));
  const today = def.pit.map((v) => wrapS(v, L));
  let overlap = null;
  if (working) {
    const a0 = dS(today[0], working.from, L), b0 = dS(today[0], working.to, L), t1 = dS(today[0], today[1], L);
    overlap = r1(Math.max(0, Math.min(b0, t1) - Math.max(a0, 0)));
  }
  const pt = (k) => ({ s: r1(own[k].s), sFromLine: r1(sSigned(own[k].s, L)), row: own[k].i, lat: r1(own[k].lat), edge: r1(own[k].edge) });
  return {
    own, side, leave, rejoin, where,
    summary: {
      side: side > 0 ? 'left' : 'right', sideSign: side, rows: n, length_m: r1(len),
      entry: { ...pt(0), onTrack: Math.abs(own[0].lat) <= own[0].edge + 1 },
      exit: { ...pt(n - 1), onTrack: Math.abs(own[n - 1].lat) <= own[n - 1].edge + 1 },
      leavesTrack: leave >= 0 ? { laneRow: leave, ...pt(leave) } : null,
      rejoinsTrack: rejoin >= 0 ? { laneRow: rejoin, ...pt(rejoin) } : null,
      lapSpan_m: r1(sRel.at(-1)),
      maxOffset_m: r1(Math.abs(own[far].lat)), maxOffsetAt: { laneRow: far, s: r1(own[far].s), sFromLine: r1(sSigned(own[far].s, L)) },
      working: working && { ...working, fromLine: r1(sSigned(working.from, L)), toLine: r1(sSigned(working.to, L)) },
      crossesTrack: crossings,
      farFromTrack: farRuns.map((f) => ({ laneRows: [f.fromRow, f.toRow], s: [f.from, f.to], sFromLine: [r1(sSigned(f.from, L)), r1(sSigned(f.to, L))], maxBeyondEdge_m: f.maxBeyondEdge_m })),
      otherPartOfLap: groups.map((g) => ({ laneRows: [g.fromRow, g.toRow], trackS: g.trackS, minDistance_m: g.minD, kind: g.kind })),
      today: { pit: def.pit, pitSide: def.pitSide, sameSide: def.pitSide === side, workingOverlap_m: overlap },
      checks: {
        endsOnTrack: Math.abs(own[0].lat) <= own[0].edge + 1 && Math.abs(own[n - 1].lat) <= own[n - 1].edge + 1,
        rowsInsideTrackEdgeBetween: inside, rowsOnOtherSide: wrongSide, rowsGoingBackwards: back,
      },
    },
  };
}

const parseWidth = (v) => { const m = /^\s*(\d+(?:\.\d+)?)\s*(m)?\s*$/.exec(v ?? ''); return m ? +m[1] : null; };

// a hand-made lane: our centreline offset to the side, swinging out over `ramp` m at each end
function approxLane(tr, a) {
  const len = dS(a.from, a.to, tr.L) > 0 ? dS(a.from, a.to, tr.L) : wrapS(a.to - a.from, tr.L);
  const n = Math.round(len / SPACING), out = [];
  for (let k = 0; k <= n; k++) {
    const u = (k * len) / n, s = a.from + u;
    const o = project(tr, pointAt(tr, s), s, 5), edge = a.side > 0 ? o.wl : o.wr;
    const e = Math.min(1, u / a.ramp, (len - u) / a.ramp), sm = e * e * (3 - 2 * e);
    out.push({ p: pointAt(tr, s, a.side * (sm * a.out + (1 - sm) * 0)), seg: 0, edge });
  }
  return out;
}

function buildCircuit(id, c, def, cache, geoDir) {
  const tr = readOurs(id), proj = projector(c.bbox);
  const file = path.join(cache, `${id}.json`);
  if (!fs.existsSync(file) && !c.approx) throw new Error(`no ${file}: run fetch first`);
  const osm = fs.existsSync(file) ? loadOsm(file, proj) : { ways: new Map(), rels: [], stamp: null };
  const reg = register(id, c, tr, osm, proj, geoDir);
  const notes = c.note ? [c.note] : [];
  let rows, quality, srcLine, widths = null, osmInfo = null, tunnels = [];
  const pw = c.approx ? null : pitWays(c, osm, reg, tr);
  if (c.approx || !pw.ws.length) {
    if (!c.approx) throw new Error(`${id}: no pit lane in OSM and no approx entry`);
    rows = approxLane(tr, c.approx); quality = 'approx';
    srcLine = `# APPROXIMATE, made by hand (not surveyed): ${c.approx.why}`;
  } else {
    // each group of connected ways is a lane (a karting track's has its own); the one that passes the start line
    // is the circuit's, else the longest
    const lanes = [];
    for (const comp of components(pw.ws)) {
      const ch = chain(comp);
      if (!ch) { notes.push(`OSM ways ${comp.map((w) => w.id).join(' ')} branch: not used (list the lane's ways in CIRCUITS.pit)`); continue; }
      let P = ch.P.map((p) => apply(reg.T, p)), way = ch.way;
      // racing direction: the lane's projection on our lap must move forwards
      let a = analyse(id, tr, resample(P, SPACING), def, {}).summary;
      if (a.lapSpan_m < 0) { P = P.reverse(); way = [...way].reverse(); a = analyse(id, tr, resample(P, SPACING), def, {}).summary; }
      const passesLine = a.entry.sFromLine <= 0 && a.exit.sFromLine >= 0 && a.lapSpan_m < tr.L / 2;
      lanes.push({ ch, P, way, len: polyLen(P), passesLine });
    }
    lanes.sort((x, y) => (y.passesLine - x.passesLine) || (y.len - x.len));
    if (!lanes.length) throw new Error(`${id}: pit ways ${pw.ws.map((w) => w.id)} do not make a lane`);
    for (const o of lanes.slice(1)) notes.push(`another OSM pit lane nearby not used: ways ${o.ch.ids.join(' ')} (${Math.round(o.len)} m${o.passesLine ? '' : ', not past the line'})`);
    const { ch, P, way } = lanes[0];
    rows = resample(P, SPACING).map((r) => ({ ...r, way: way[r.seg] }));
    quality = 'osm';
    const ws = rows.map((r) => parseWidth(pw.ws.find((w) => w.id === r.way)?.tags.width));
    if (ws.some((w) => w !== null)) widths = ws;
    for (const w of pw.ws.filter((x) => ch.ids.includes(x.id))) if (w.tags.tunnel || w.tags.bridge || (w.tags.layer && w.tags.layer !== '0')) tunnels.push({ way: w.id, tunnel: w.tags.tunnel, bridge: w.tags.bridge, layer: w.tags.layer });
    osmInfo = { ways: ch.ids, gapsBridged: ch.gaps, how: pw.how, data: osm.stamp };
    srcLine = `# Source: OpenStreetMap (© OpenStreetMap contributors, ODbL 1.0), ways ${ch.ids.join(' ')} (${pw.how}), data as of ${osm.stamp}.`;
  }
  const buildings = quality === 'osm' ? [...osm.ways.values()].filter((w) => isPitBuilding(w.tags)).map((w) => w.P.map((p) => apply(reg.T, p))) : [];
  const wayTags = new Map((pw?.ws ?? []).map((w) => [w.id, w.tags]));
  let an = analyse(id, tr, rows, def, { buildings, wayTags });
  if (quality === 'osm') {
    // keep the lane from its last point on the track before it leaves to its first one after it rejoins
    // (a stub of under 30 m beyond the other edge at either end, the way drawn across the track, is dropped)
    const absLat = (k) => Math.abs(an.own[k].lat), runs = [];
    an.where.forEach((v, k) => { if (!v) return; const r = runs.at(-1); if (r && r.v === v && r.b === k - 1) r.b = k; else runs.push({ a: k, b: k, v }); });
    let from = 0, to = rows.length - 1;
    while (runs.length > 1 && runs[0].b - runs[0].a < 6 && runs[1].v !== runs[0].v) from = runs.shift().b + 1;
    while (runs.length > 1 && runs.at(-1).b - runs.at(-1).a < 6 && runs.at(-2).v !== runs.at(-1).v) to = runs.pop().a - 1;
    let k0 = from, k1 = to;
    for (let k = from; k <= (runs[0]?.a ?? from); k++) if (absLat(k) <= absLat(k0)) k0 = k;
    for (let k = to; k >= (runs.at(-1)?.b ?? to); k--) if (absLat(k) <= absLat(k1)) k1 = k;
    if (k0 > 0 || k1 < rows.length - 1) {
      notes.push(`OSM lane trimmed to where it meets the track (${k0} rows off the start, ${rows.length - 1 - k1} off the end)`);
      rows = rows.slice(k0, k1 + 1); if (widths) widths = widths.slice(k0, k1 + 1);
      an = analyse(id, tr, rows, def, { buildings, wayTags });
    }
  }
  const rg = reg.res, th = (Math.atan2(reg.T.s, reg.T.c) * 180) / Math.PI;
  const summary = {
    name: def.name, quality, ...an.summary,
    widthFromOsm: !!widths,
    tunnelsOrBridges: tunnels,
    registration: { fittedTo: reg.label, median_m: r1(rg.median), p95_m: r1(rg.p95), max_m: r1(rg.max), mappedShare: Math.round(rg.coverage * 100) / 100, mappedMedian_m: r1(rg.nearMedian), mappedP95_m: r1(rg.nearP95), rotation_deg: Math.round(th * 100) / 100, bacingerMedian_m: r1(reg.geoRes.median) },
    osm: osmInfo, notes,
  };
  const hasW = !!widths;
  const lines = [`# x_m,y_m,s_m,lat_m${hasW ? ',w_m' : ''}`, srcLine,
    quality === 'approx'
      ? `# Pit lane of ${def.name}, in the frame of tracks/${id}.csv, by scripts/tracks/pits.mjs: an offset of our own centreline. Rows ${SPACING} m apart in the racing direction; s_m/lat_m: position on our centreline (lat + = left).`
      : `# Pit lane of ${def.name}, in the frame of tracks/${id}.csv, by scripts/tracks/pits.mjs: OSM fitted to our centreline (${reg.label}, rotation ${th.toFixed(2)} deg),`
        + ` residual median ${rg.median.toFixed(1)} m, 95th percentile ${rg.p95.toFixed(1)} m. Rows ${SPACING} m apart in the racing direction; s_m/lat_m: position on our centreline (lat + = left).`,
    `# quality: ${quality}; side: ${summary.side}; ${hasW ? 'w_m: full width from OSM\'s width tag' : 'no width in the source'}.`,
    ...rows.map((r, k) => [r.p[0].toFixed(3), r.p[1].toFixed(3), an.own[k].s.toFixed(1), an.own[k].lat.toFixed(2), ...(hasW ? [widths[k] ?? ''] : [])].join(','))];
  return { tr, reg, osm, rows, an, summary, text: lines.join('\n') + '\n', buildings, pw };
}

// ---------------------------------------------------------------------------------------------------- picture
function svg(id, r, def) {
  const { tr, reg, rows, an, summary } = r;
  const W = 1500, H = 760, out = [];
  const edgeRing = (side) => tr.P.map((p, i) => { const o = pointAt(tr, tr.S[i], side * (side > 0 ? tr.wl[i] : tr.wr[i])); return o; });
  const panel = (x0, y0, w, h, box, detail) => {
    const sc = Math.min(w / (box[2] - box[0]), h / (box[3] - box[1]));
    const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
    const X = (p) => (x0 + w / 2 + (p[0] - cx) * sc).toFixed(1), Y = (p) => (y0 + h / 2 - (p[1] - cy) * sc).toFixed(1);
    const pl = (P, st, close) => `<path d="M${P.map((p) => `${X(p)},${Y(p)}`).join('L')}${close ? 'Z' : ''}" ${st}/>`;
    out.push(`<svg x="${x0}" y="${y0}" width="${w}" height="${h}" overflow="hidden"><rect x="0" y="0" width="${w}" height="${h}" fill="#f4f1ea"/></svg>`);
    out.push(`<g clip-path="url(#c${x0})"><clipPath id="c${x0}"><rect x="${x0}" y="${y0}" width="${w}" height="${h}"/></clipPath>`);
    const L = edgeRing(1), R = edgeRing(-1);
    out.push(`<path d="M${L.map((p) => `${X(p)},${Y(p)}`).join('L')}ZM${R.map((p) => `${X(p)},${Y(p)}`).join('L')}Z" fill="#9a9a9a" fill-rule="evenodd" stroke="none"/>`);
    out.push(pl([...tr.P, tr.P[0]], 'fill="none" stroke="#333" stroke-width="0.7"'));
    // today's pit building, 15 m beyond the edge on pitSide
    const pb = [];
    for (let s = def.pit[0]; s <= def.pit[1]; s += 5) { const o = project(tr, pointAt(tr, s), wrapS(s, tr.L), 6); pb.push(pointAt(tr, s, def.pitSide * ((def.pitSide > 0 ? o.wl : o.wr) + 14))); }
    out.push(pl(pb, `fill="none" stroke="#f08c00" stroke-width="${detail ? 6 : 3}" stroke-opacity="0.8"`));
    for (const b of r.buildings) out.push(pl(b, 'fill="#c9a0dc" fill-opacity="0.6" stroke="#7b3fa0" stroke-width="0.8"', true));
    for (const w of reg.ws ?? []) out.push(pl(w.P.map((p) => apply(reg.T, p)), 'fill="none" stroke="#e03131" stroke-width="1"'));
    for (const w of r.pw?.ws ?? []) {
      const P = w.P.map((p) => apply(reg.T, p)), m = P[Math.floor(P.length / 2)];
      out.push(pl(P, 'fill="none" stroke="#74c0fc" stroke-width="5" stroke-opacity="0.6"'));
      if (detail) out.push(`<text x="${X(m)}" y="${Y(m)}" font-size="10" fill="#0b7285">${w.id}</text>`);
    }
    out.push(pl(rows.map((q) => q.p), `fill="none" stroke="${summary.quality === 'osm' ? '#1c4fd8' : '#e8590c'}" stroke-width="${detail ? 2.5 : 2}"`));
    if (detail) for (const q of rows) out.push(`<circle cx="${X(q.p)}" cy="${Y(q.p)}" r="1.6" fill="#1c4fd8"/>`);
    // start line
    const a = pointAt(tr, 0, tr.wl[0] + 4), b = pointAt(tr, 0, -tr.wr[0] - 4);
    out.push(`<line x1="${X(a)}" y1="${Y(a)}" x2="${X(b)}" y2="${Y(b)}" stroke="#000" stroke-width="4"/>`);
    // direction arrow at 60 m
    const d0 = pointAt(tr, 40), d1 = pointAt(tr, 90);
    out.push(`<line x1="${X(d0)}" y1="${Y(d0)}" x2="${X(d1)}" y2="${Y(d1)}" stroke="#2b8a3e" stroke-width="3" marker-end="url(#arr)"/>`);
    out.push(`<circle cx="${X(rows[0].p)}" cy="${Y(rows[0].p)}" r="6" fill="none" stroke="#2b8a3e" stroke-width="2.5"/>`);
    out.push(`<circle cx="${X(rows.at(-1).p)}" cy="${Y(rows.at(-1).p)}" r="6" fill="none" stroke="#c92a2a" stroke-width="2.5"/>`);
    if (summary.working) {
      const len = wrapS(summary.working.to - summary.working.from, tr.L);
      const ws = an.own.map((o, k) => [o, k]).filter(([o]) => wrapS(o.s - summary.working.from, tr.L) <= len)
        .map(([o, k]) => pointAt(tr, o.s, o.lat + summary.sideSign * 6));
      if (ws.length > 1) out.push(pl(ws, `fill="none" stroke="#7b3fa0" stroke-width="3" stroke-dasharray="6 4"`));
    }
    for (const g of summary.otherPartOfLap) { const p = rows[g.laneRows[0]].p; out.push(`<circle cx="${X(p)}" cy="${Y(p)}" r="9" fill="none" stroke="#e8590c" stroke-width="2"/>`); }
    // scale bar
    const m = detail ? 50 : 500;
    out.push(`<line x1="${x0 + 10}" y1="${y0 + h - 12}" x2="${x0 + 10 + m * sc}" y2="${y0 + h - 12}" stroke="#000" stroke-width="2"/><text x="${x0 + 10}" y="${y0 + h - 18}" font-size="12">${m} m</text>`);
    out.push('</g>');
  };
  const bb = (P, pad) => { const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]); return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad]; };
  out.push(`<defs><marker id="arr" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto"><path d="M0,0L8,4L0,8Z" fill="#2b8a3e"/></marker></defs>`);
  panel(0, 40, 560, 720, bb(tr.P, 60));
  panel(570, 40, 930, 720, bb(rows.map((q) => q.p), 70), true);
  const s = summary, g = s.registration;
  out.push(`<text x="10" y="18" font-size="15" font-family="sans-serif"><tspan font-weight="bold">${id}</tspan>  ${s.quality}  side ${s.side} (today ${def.pitSide > 0 ? 'left' : 'right'})  entry s ${s.entry.s} (${s.entry.sFromLine})  exit s ${s.exit.s} (${s.exit.sFromLine})  length ${s.length_m} m  max offset ${s.maxOffset_m} m  fit ${g.fittedTo}: median ${g.median_m} m p95 ${g.p95_m} m rot ${g.rotation_deg} deg</text>`);
  out.push(`<text x="10" y="34" font-size="12" font-family="sans-serif">grey: our track; red: registered OSM circuit; blue: pit lane (light blue: OSM ways used); orange: today's pit building; purple dashed: working stretch; green/red circles: lane start/end; black: start line; green arrow: racing direction</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#fff"/>${out.join('\n')}</svg>`;
}

// ---------------------------------------------------------------------------------------------------- main
async function build(cache, geoDir, rest) {
  let svgDir = null;
  const only = [];
  for (let i = 0; i < rest.length; i++) { if (rest[i] === '--svg') svgDir = rest[++i]; else only.push(rest[i]); }
  const defs = trackDefs();
  fs.mkdirSync(outDir, { recursive: true });
  const indexFile = path.join(outDir, 'index.json');
  const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : {};
  index.about = 'Real pit lanes, one CSV per circuit in this folder (x_m,y_m,s_m,lat_m[,w_m]; see scripts/tracks/pits.mjs). s: m along our centreline from the line; sFromLine: the same, negative before the line; row: nearest 0-based data row of tracks/<id>.csv (comment lines not counted); sideSign: +1 left, -1 right, as TrackDef.pitSide; lat: + = left of our centreline. Source: OpenStreetMap, © OpenStreetMap contributors, ODbL 1.0, except quality "approx" (made by hand).';
  index.circuits ??= {};
  let sharp = null;
  if (svgDir) { fs.mkdirSync(svgDir, { recursive: true }); try { sharp = (await import('sharp')).default; } catch { /* svg only */ } }
  for (const [id, c] of Object.entries(CIRCUITS)) {
    if (only.length && !only.includes(id)) continue;
    let r;
    try { r = buildCircuit(id, c, defs[id], cache, geoDir); } catch (e) { console.log(`${id.padEnd(12)} FAILED: ${e.message}`); continue; }
    fs.writeFileSync(path.join(outDir, `${id}.csv`), r.text);
    index.circuits[id] = r.summary;
    const s = r.summary, g = s.registration, ck = s.checks;
    const warn = [];
    if (!ck.endsOnTrack) warn.push('an end is off the track');
    if (ck.rowsInsideTrackEdgeBetween) warn.push(`${ck.rowsInsideTrackEdgeBetween} rows inside the track edge`);
    if (ck.rowsOnOtherSide) warn.push(`${ck.rowsOnOtherSide} rows on the other side`);
    if (ck.rowsGoingBackwards) warn.push(`${ck.rowsGoingBackwards} rows going backwards`);
    if (s.crossesTrack.length) warn.push(`crosses the track: ${s.crossesTrack.map((x) => `${x.how} at s ${x.s}`).join(', ')}`);
    if (s.otherPartOfLap.length) warn.push(`near another part of the lap: ${s.otherPartOfLap.map((o) => `${o.kind} at s ${o.trackS[0]}`).join(', ')}`);
    if (!s.today.sameSide) warn.push('other side than pitSide');
    if (g.p95_m > 8) warn.push(`fit p95 ${g.p95_m} m`);
    console.log(`${id.padEnd(12)} ${s.quality.padEnd(6)} ${s.side.padEnd(5)} entry ${String(s.entry.sFromLine).padStart(7)} exit ${String(s.exit.sFromLine).padStart(7)} len ${String(s.length_m).padStart(6)} off ${String(s.maxOffset_m).padStart(5)} fit ${g.median_m}/${g.p95_m} m${g.mappedShare < 0.95 ? ` (${Math.round(g.mappedShare * 100)}% mapped: ${g.mappedMedian_m}/${g.mappedP95_m} m)` : ''}  ${warn.join('; ')}`);
    if (svgDir) {
      const text = svg(id, r, defs[id]);
      fs.writeFileSync(path.join(svgDir, `${id}.svg`), text);
      if (sharp) await sharp(Buffer.from(text)).png().toFile(path.join(svgDir, `${id}.png`));
    }
  }
  const sorted = {};
  for (const id of Object.keys(CIRCUITS)) if (index.circuits[id]) sorted[id] = index.circuits[id];
  index.circuits = sorted;
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 1) + '\n');
}

const [cmd, cache, ...rest] = process.argv.slice(2);
if (cmd === 'fetch' && cache) await fetchAll(cache, rest);
else if (cmd === 'build' && cache && rest[0]) await build(cache, rest[0], rest.slice(1));
else { console.error('usage: node scripts/tracks/pits.mjs fetch <cache> [id ...] | build <cache> <f1-circuits> [--svg <dir>] [id ...]'); process.exit(1); }
