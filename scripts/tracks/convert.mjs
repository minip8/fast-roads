// Makes the circuit CSVs in tracks/ (x_m, y_m, w_tr_right_m, w_tr_left_m: centreline in metres, x east, y north,
// first row at the start/finish line, rows in the racing direction, about 5 m apart) from two open sources:
//
//   TUM   github.com/TUMFTM/racetrack-database (LGPL-3.0): tracks/<Name>.csv, already in this format, with widths.
//         Copied as they are (a header added).
//   GEO   github.com/bacinger/f1-circuits (MIT): circuits/<id>.geojson, a lon/lat centreline LineString with no
//         widths, about 10-40 m between points, not always starting at the line or running in the racing direction.
//         Projected to local metres (tangent plane at the circuit's centre, WGS84 radii), turned to the racing
//         direction, passed through a centripetal Catmull-Rom spline, resampled every 5 m from the start/finish line,
//         lightly smoothed, and given constant widths (narrower at the street circuits; where the TUM database has an
//         older layout of the same circuit, its mean widths).
//
//   git clone --depth 1 https://github.com/TUMFTM/racetrack-database.git <tum>
//   git clone --depth 1 https://github.com/bacinger/f1-circuits.git <geo>
//   node scripts/tracks/convert.mjs <tum> <geo> [id ...]     # all circuits below, or just these
//
// Melbourne and Silverstone (TUM) were added before this script and are not remade by it. Check a remade circuit's
// lap length against the official one (test/tracks.test.ts does) and look at it in the game.
import fs from 'node:fs';
import path from 'node:path';

const SPACING = 5;   // m between output rows, as in the TUM files

// start: [lat, lon] near the start/finish line (the nearest point of the centreline is taken), or omitted for the
// source's first point. reverse: the source runs against the racing direction. width: [right, left] half-widths (m),
// or a TUM file whose mean widths are used. smooth: passes of a 3-point moving average after resampling.
const CIRCUITS = {
  shanghai: { tum: 'Shanghai' },
  suzuka: { tum: 'Suzuka' },
  miami: { geo: 'us-2022', width: [6.5, 6.5] },
  montreal: { tum: 'Montreal' },
  monaco: { geo: 'mc-1929', start: [43.73480, 7.42132], width: [4.6, 4.6], separate: 16.5 },
  barcelona: { geo: 'es-1991', width: 'Catalunya' },          // TUM's Catalunya still has the final chicane (to 2022)
  spielberg: { tum: 'Spielberg' },
  spa: { tum: 'Spa' },
  hungaroring: { tum: 'Budapest' },
  zandvoort: { geo: 'nl-1948', width: 'Zandvoort' },         // TUM's Zandvoort is the layout before the 2020 rebuild
  monza: { tum: 'Monza' },
  madrid: { geo: 'es-2026', width: [6.5, 6.5] },
  baku: { geo: 'az-2016', width: [5.5, 5.5], separate: 19 },
  singapore: { geo: 'sg-2008', reverse: true, width: [5.5, 5.5] },
  austin: { tum: 'Austin' },
  mexico: { tum: 'MexicoCity' },
  saopaulo: { tum: 'SaoPaulo' },
  lasvegas: { geo: 'us-2023', width: [7, 7] },
  lusail: { geo: 'qa-2004', width: [6, 6], smooth: 4 },
  yasmarina: { geo: 'ae-2009', width: 'YasMarina' },         // TUM's Yas Marina is the layout before the 2021 changes
  bahrain: { tum: 'Sakhir' },
  jeddah: { geo: 'sa-2021', width: [6, 6] },
};

const [tumDir, geoDir, ...only] = process.argv.slice(2);
if (!tumDir || !geoDir) { console.error('usage: node scripts/tracks/convert.mjs <racetrack-database dir> <f1-circuits dir> [id ...]'); process.exit(1); }
const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), '../../tracks');
const f = (v) => v.toFixed(3);

function readTum(name) {
  const rows = fs.readFileSync(path.join(tumDir, 'tracks', `${name}.csv`), 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && l[0] !== '#');
  return rows.map((l) => l.split(',').map(Number));
}

function fromGeo(id, c) {
  const geo = JSON.parse(fs.readFileSync(path.join(geoDir, 'circuits', `${c.geo}.geojson`), 'utf8'));
  let ll = geo.features[0].geometry.coordinates.map(([lon, lat]) => [lon, lat]);
  if (ll.length > 1 && ll[0][0] === ll.at(-1)[0] && ll[0][1] === ll.at(-1)[1]) ll.pop();
  // local tangent plane at the centre of the bounding box
  const lons = ll.map((p) => p[0]), lats = ll.map((p) => p[1]);
  const lon0 = (Math.min(...lons) + Math.max(...lons)) / 2, lat0 = (Math.min(...lats) + Math.max(...lats)) / 2;
  const a = 6378137, e2 = 6.69437999014e-3, sl = Math.sin((lat0 * Math.PI) / 180), w = 1 - e2 * sl * sl;
  const M = (a * (1 - e2)) / Math.pow(w, 1.5), Nr = a / Math.sqrt(w), rad = Math.PI / 180;
  const proj = ([lon, lat]) => [(lon - lon0) * rad * Nr * Math.cos(lat0 * rad), (lat - lat0) * rad * M];
  let P = ll.map(proj);
  if (c.reverse) P.reverse();

  // centripetal Catmull-Rom through the source points, densely sampled
  const n = P.length, dense = [];
  for (let i = 0; i < n; i++) {
    const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n], p3 = P[(i + 2) % n];
    const d = (p, q) => Math.max(1e-6, Math.sqrt(Math.hypot(q[0] - p[0], q[1] - p[1])));
    const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
    const SUB = 40;
    for (let j = 0; j < SUB; j++) {
      const t = t1 + ((t2 - t1) * j) / SUB;
      const L = (pa, pb, ta, tb) => [0, 1].map((k) => ((tb - t) * pa[k] + (t - ta) * pb[k]) / (tb - ta));
      const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
      const B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
      dense.push(L(B1, B2, t1, t2));
    }
  }
  // start: nearest dense point to the given spot
  let i0 = 0;
  if (c.start) {
    const s = proj([c.start[1], c.start[0]]);
    let bd = Infinity;
    dense.forEach((p, i) => { const dd = Math.hypot(p[0] - s[0], p[1] - s[1]); if (dd < bd) { bd = dd; i0 = i; } });
    if (bd > 30) throw new Error(`${id}: start spot is ${bd.toFixed(0)} m from the centreline`);
  }
  const D = dense.slice(i0).concat(dense.slice(0, i0)), m = D.length, cum = [0];
  for (let i = 0; i < m; i++) { const p = D[i], q = D[(i + 1) % m]; cum.push(cum[i] + Math.hypot(q[0] - p[0], q[1] - p[1])); }
  const len = cum[m], N = Math.round(len / SPACING);
  let X = new Float64Array(N), Y = new Float64Array(N);
  for (let i = 0, j = 0; i < N; i++) {
    const s = (i * len) / N;
    while (cum[j + 1] < s) j++;
    const t = (s - cum[j]) / (cum[j + 1] - cum[j] || 1), p = D[j], q = D[(j + 1) % m];
    X[i] = p[0] + (q[0] - p[0]) * t; Y[i] = p[1] + (q[1] - p[1]) * t;
  }
  for (let pass = 0; pass < (c.smooth ?? 2); pass++) {
    const x2 = new Float64Array(N), y2 = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a1 = (i - 1 + N) % N, b1 = (i + 1) % N;
      x2[i] = (X[a1] + 2 * X[i] + X[b1]) / 4; y2[i] = (Y[a1] + 2 * Y[i] + Y[b1]) / 4;
    }
    X = x2; Y = y2;
  }
  if (c.separate) [X, Y] = separate(X, Y, c.separate);
  // put the line at the origin, as in the TUM files (they start near 0,0)
  const ox = X[0], oy = Y[0];
  let wr, wl;
  if (typeof c.width === 'string') {
    const t = readTum(c.width);
    wr = t.reduce((s, r) => s + r[2], 0) / t.length; wl = t.reduce((s, r) => s + r[3], 0) / t.length;
  } else [wr, wl] = c.width;
  const rows = [];
  for (let i = 0; i < N; i++) rows.push([X[i] - ox, Y[i] - oy, wr, wl]);
  const props = geo.features[0].properties;
  return {
    rows,
    header: [`# Source: bacinger/f1-circuits (MIT, Copyright (c) 2019-2025 Tomislav Bacinger), circuits/${c.geo}.geojson`
      + ` (${props.Name}). Projected to metres, resampled every ${SPACING} m by scripts/tracks/convert.mjs;`
      + ` widths ${typeof c.width === 'string' ? `are the mean of TUMFTM/racetrack-database (LGPL-3.0) ${c.width}.csv, an older layout` : 'assumed (the source has none)'}.`],
  };
}

// Where two parts of the lap run side by side (a dual carriageway used in both directions, the legs of a hairpin),
// the hand-drawn source often puts their centrelines closer than the roads really are, which would leave no room
// for the wall between them. Push each such stretch sideways, away from the other part, until the centrelines are
// `minSep` m apart, spreading the move smoothly along the lap.
function separate(X, Y, minSep) {
  const N = X.length;
  X = Float64Array.from(X); Y = Float64Array.from(Y);
  for (let iter = 0; iter < 40; iter++) {
    const dx = new Float64Array(N), dy = new Float64Array(N);
    let worst = 0;
    for (let i = 0; i < N; i++) {
      let bd = Infinity, bj = -1;
      for (let j = 0; j < N; j++) {
        const gap = Math.min(Math.abs(i - j), N - Math.abs(i - j)) * SPACING;
        if (gap < 90) continue;
        const d = Math.hypot(X[i] - X[j], Y[i] - Y[j]);
        if (d < bd) { bd = d; bj = j; }
      }
      if (bd >= minSep) continue;
      worst = Math.max(worst, minSep - bd);
      const a = (i - 1 + N) % N, b = (i + 1) % N;
      let nx = -(Y[b] - Y[a]), ny = X[b] - X[a];
      const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
      const side = Math.sign((X[i] - X[bj]) * nx + (Y[i] - Y[bj]) * ny) || 1;
      const push = ((minSep - bd) / 2) * 0.5;
      dx[i] = nx * side * push; dy[i] = ny * side * push;
    }
    if (worst < 0.05) break;
    // spread the push along the lap (about +-40 m), so the road bends gently into its new line
    for (let pass = 0; pass < 8; pass++) {
      const x2 = new Float64Array(N), y2 = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        const a = (i - 1 + N) % N, b = (i + 1) % N;
        x2[i] = Math.abs(dx[i]) > 0 ? dx[i] : (dx[a] + dx[b]) / 2 * 0.95;
        y2[i] = Math.abs(dy[i]) > 0 ? dy[i] : (dy[a] + dy[b]) / 2 * 0.95;
      }
      dx.set(x2); dy.set(y2);
    }
    for (let i = 0; i < N; i++) { X[i] += dx[i]; Y[i] += dy[i]; }
  }
  return [X, Y];
}

for (const [id, c] of Object.entries(CIRCUITS)) {
  if (only.length && !only.includes(id)) continue;
  let rows, header;
  if (c.tum) {
    rows = readTum(c.tum);
    header = [`# Source: TUMFTM/racetrack-database (LGPL-3.0), ${c.tum}.csv`];
  } else ({ rows, header } = fromGeo(id, c));
  const text = ['# x_m,y_m,w_tr_right_m,w_tr_left_m', ...header,
    ...rows.map((r) => (c.tum ? r.map(String) : [f(r[0]), f(r[1]), r[2].toFixed(2), r[3].toFixed(2)]).join(','))].join('\n') + '\n';
  fs.writeFileSync(path.join(outDir, `${id}.csv`), text);
  let L = 0;
  for (let i = 0; i < rows.length; i++) { const p = rows[i], q = rows[(i + 1) % rows.length]; L += Math.hypot(q[0] - p[0], q[1] - p[1]); }
  console.log(`${id.padEnd(12)} ${String(rows.length).padStart(5)} rows  ${(L / 1000).toFixed(3)} km`);
}
