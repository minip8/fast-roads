import * as THREE from 'three';
import { Batch } from './batch';
import { gridSlots } from './raceGeometry';
import { clearOf, mulberry32, nearestSample } from './scenery';
import { canvasTex } from './textures';
import { pointAt, type Track } from './track';
import type { TrackDef } from './tracks';
import { wrapI } from './util';

// ============================================================================
// What stands round a circuit beyond its walls, from the track and a few fields of its TrackDef (scene, flora, hills,
// buildings): woods and trees of the place's kind, city blocks along a street circuit's walls and a skyline, hills on
// the horizon, catch fences, a bridge or two over the straights, the grid's painted slots.
// Everything is placed from the track and a seeded generator (the same for every client and reload), and every solid
// thing goes through scenery.ts's clearOf: never on the road or run-off, inside a wall, over another stretch of the
// lap or where the pit lane will be. Looks only: no colliders. Built in the browser only (canvas textures).
// ============================================================================
export type SceneKind = 'forest' | 'park' | 'country' | 'dry' | 'city' | 'desert' | 'dunes';
export type Flora = 'broadleaf' | 'conifer' | 'mixed' | 'palm' | 'scrub';
// Buildings along a street circuit's walls (city kind) and in the skyline: heights (m), the share of towers (up to
// `tower` m), the façade colours, lit signs on the fronts, and how far back from the walls the first row stands (m).
export interface Buildings { h: [min: number, max: number]; towers: number; tower: number; colors: number[]; signs?: boolean; setback?: number }

const KIND_BUILDINGS: Buildings = { h: [14, 40], towers: 0.1, tower: 90, colors: [0xd8d2c4, 0xb9c0c6, 0xe2d6bc, 0x9aa6b2, 0xcfc8bd] };

export interface Trackside {
  setDetail(level: 'high' | 'low'): void;
  dispose(): void;
}

export function buildTrackside(tr: Track, def: TrackDef, scene: THREE.Scene, lineMat: THREE.Material): Trackside {
  const group = new THREE.Group();
  group.name = 'trackside';
  scene.add(group);
  const owned: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(x: T) => { owned.push(x); return x; };
  const counted: { mesh: THREE.InstancedMesh; full: number }[] = [];

  const trees = buildTrees(tr, def, own);
  for (const m of trees) { group.add(m); counted.push({ mesh: m, full: m.count }); }
  const facade = facadeMaterials(own);
  const parts = [
    ...(def.scene === 'city' ? buildCity(tr, def, facade, own) : []), ...(def.skyline ? buildSkyline(tr, def, facade, own) : []),
    buildHills(tr, def, own), ...buildFences(tr, def, own), ...buildBridges(tr, def, own), buildGridMarks(tr, lineMat, own),
  ];
  group.add(...parts);

  return {
    setDetail(level) { for (const c of counted) c.mesh.count = level === 'high' ? c.full : Math.round(c.full * 0.4); },
    dispose() { scene.remove(group); for (const o of owned) o.dispose(); },
  };
}

type Own = <T extends { dispose(): void }>(x: T) => T;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler(), _c = new THREE.Color();

// ---------------------------------------------------------------------------- seeded value noise
function noise2(seed: number) {
  const h = (i: number, j: number) => { let t = (i * 374761393 + j * 668265263 + seed * 2147483647) | 0; t = Math.imul(t ^ (t >>> 13), 1274126177); return ((t ^ (t >>> 16)) >>> 0) / 4294967296; };
  const f = (t: number) => t * t * (3 - 2 * t);
  const v = (x: number, z: number) => {
    const i = Math.floor(x), j = Math.floor(z), u = f(x - i), w = f(z - j);
    return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - w) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * w;
  };
  return (x: number, z: number) => 0.6 * v(x, z) + 0.3 * v(x * 2.1 + 5.3, z * 2.1 + 1.7) + 0.1 * v(x * 4.3, z * 4.3);
}
// Woods and clearings (0..1 over a few hundred metres; above WOODS a wood at a forest circuit): the trees and the
// ground under them (scenery.ts darkens the terrain there) read the same field.
export const WOODS = 0.42;
export function woodsOf(def: Pick<TrackDef, 'id'>) { const n = noise2(seedOf(def.id)); return (x: number, z: number) => n(x / 160, z / 160); }
export const seedOf = (id: string) => { let h = 2166136261; for (let k = 0; k < id.length; k++) h = Math.imul(h ^ id.charCodeAt(k), 16777619); return h >>> 0; };

// ---------------------------------------------------------------------------- trees
// Each kind of tree is two instanced meshes (trunk and crown) sharing the instances' transforms. Woods: a noise field
// thins them into stands and clearings; trees keep 10 m beyond the walls on the outside of bends and on straights,
// and 55 m from the track on the inside of a bend (so none hides the next corner). The instances are shuffled, so a
// lower Scenery detail can draw a random share of them (InstancedMesh.count).
interface TreeType { trunk: THREE.BufferGeometry; crown: THREE.BufferGeometry; trunkColor: number; crowns: number[]; double?: boolean }
function treeTypes(): Record<Exclude<Flora, 'mixed'>, TreeType> {
  const lobes = new THREE.IcosahedronGeometry(2.4, 0).scale(1, 1.15, 1).translate(0, 5.0, 0);
  const lobe2 = new THREE.IcosahedronGeometry(1.8, 0).translate(0.9, 6.4, 0.5);
  const lobe3 = new THREE.IcosahedronGeometry(1.7, 0).translate(-1.0, 5.9, -0.6);
  const broad = mergeSimple([lobes, lobe2, lobe3]);
  const cone1 = new THREE.ConeGeometry(2.3, 5.2, 7).translate(0, 4.6, 0), cone2 = new THREE.ConeGeometry(1.6, 4.2, 7).translate(0, 7.6, 0);
  const conifer = mergeSimple([cone1, cone2]);
  const fronds: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 8; k++) {
    // two planes per frond: rising from the crown, then drooping
    const a = (k / 8) * Math.PI * 2 + (k % 2) * 0.2;
    for (const [len, tilt, r0] of [[1.8, 0.35, 0], [2.0, -0.55, 1.75]] as const) {
      const g = new THREE.PlaneGeometry(len, 0.75 - r0 * 0.12).translate(len / 2, 0, 0).rotateX(Math.PI / 2);
      g.rotateZ(tilt).translate(r0, r0 > 0 ? Math.sin(0.35) * 1.8 : 0, 0).rotateY(a).translate(0, 9.2, 0);
      fronds.push(g);
    }
  }
  const palmCrown = mergeSimple(fronds);
  const bush = new THREE.IcosahedronGeometry(1.2, 0).scale(1.3, 0.7, 1.1).translate(0, 0.55, 0);
  return {
    broadleaf: { trunk: new THREE.CylinderGeometry(0.22, 0.35, 3.4, 6).translate(0, 1.7, 0), crown: broad, trunkColor: 0x6b5440, crowns: [0x4f7a34, 0x5d8a3a, 0x3f6a2e, 0x6e8f45, 0x56743a, 0x7a8f3f] },
    conifer: { trunk: new THREE.CylinderGeometry(0.16, 0.28, 3, 5).translate(0, 1.5, 0), crown: conifer, trunkColor: 0x5a4636, crowns: [0x2f5a2e, 0x355f30, 0x284f2a, 0x3d6634, 0x2c4d33] },
    palm: { trunk: new THREE.CylinderGeometry(0.16, 0.28, 9.3, 5).translate(0, 4.65, 0), crown: palmCrown, trunkColor: 0x8a7458, crowns: [0x4f7f36, 0x5c8a3c, 0x46702f, 0x6a8f42], double: true },
    scrub: { trunk: new THREE.CylinderGeometry(0.05, 0.08, 0.3, 4).translate(0, 0.15, 0), crown: bush, trunkColor: 0x6b5a44, crowns: [0x8a8a5a, 0x7a7d52, 0x9a9268, 0x6f7550] },
  };
}
function mergeSimple(list: THREE.BufferGeometry[]) {
  const b = new Batch(), m = new THREE.Matrix4(), mat = new THREE.MeshBasicMaterial(), g = new THREE.Group();
  for (const x of list) b.add(x, m, mat);
  const mesh = b.build(g)[0];
  for (const x of list) x.dispose();
  mat.dispose();
  return mesh.geometry;
}

export type TreeKind = Exclude<Flora, 'mixed'>;
export interface TreeSpot { kind: TreeKind; x: number; z: number; size: number; yaw: number; tilt: number; near: boolean }   // near: close enough to the track to cast a shadow the cars drive through
export const TREE_RADIUS = 4;   // m: what a tree's crown may reach from its trunk, for clearOf
const TREE_SIZES: Record<TreeKind, [number, number]> = { broadleaf: [0.75, 1.5], conifer: [0.8, 1.7], palm: [0.8, 1.2], scrub: [0.6, 1.4] };
// Where the trees stand (in a random order: a lower Scenery detail draws the first share of each kind).
export function treeSpots(tr: Track, def: TrackDef): TreeSpot[] {
  const rng = mulberry32(seedOf(def.id) ^ 0x7ee5), woods = woodsOf(def), mix = noise2(seedOf(def.id) ^ 0x31);
  const flora = def.flora ?? 'broadleaf';
  const pick = (x: number, z: number): TreeKind => {
    if (flora !== 'mixed') return flora;
    return mix(x / 90, z / 90) > 0.5 ? 'conifer' : 'broadleaf';
  };
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < tr.N; i++) { minX = Math.min(minX, tr.X[i]); maxX = Math.max(maxX, tr.X[i]); minZ = Math.min(minZ, tr.Z[i]); maxZ = Math.max(maxZ, tr.Z[i]); }
  const clustered = def.scene === 'forest' || def.scene === 'park';
  const out: TreeSpot[] = [];
  for (let tries = 0; tries < def.trees * 8 && out.length < def.trees; tries++) {
    // two in three candidates within ~350 m of the track (where they are seen), the rest anywhere round it
    let x: number, z: number;
    if (rng() < 0.65) {
      const i = Math.floor(rng() * tr.N), o = (rng() < 0.5 ? 1 : -1) * (20 + 330 * rng() ** 1.7);
      x = tr.X[i] + tr.NX[i] * o; z = tr.Z[i] + tr.NZ[i] * o;
    } else { x = minX - 600 + rng() * (maxX - minX + 1200); z = minZ - 600 + rng() * (maxZ - minZ + 1200); }
    const n = woods(x, z), keep = rng();
    if (clustered && n < (def.scene === 'forest' ? WOODS : 0.5)) continue;          // a clearing
    if (!clustered && keep < 0.35 && n < 0.45) continue;
    const near = nearestSample(tr, x, z);
    const side = near.lat > 0 ? 1 : -1, bar = side > 0 ? tr.barL[near.i] : tr.barR[near.i];
    const inside = side * tr.KS[near.i] > 1 / 400;
    if (near.d < (inside ? 55 : Math.max(24, bar + 10))) continue;
    if (!clearOf(tr, def, [[x, z]], { margin: TREE_RADIUS, reserve: true, buildings: true })) continue;
    const kind = pick(x, z), sz = TREE_SIZES[kind];
    out.push({ kind, x, z, size: sz[0] + rng() * (sz[1] - sz[0]), yaw: rng() * Math.PI * 2, tilt: kind === 'palm' ? (rng() - 0.5) * 0.18 : 0, near: near.d < 100 });
  }
  for (let k = out.length - 1; k > 0; k--) { const j = Math.floor(rng() * (k + 1)); [out[k], out[j]] = [out[j], out[k]]; }
  return out;
}

function buildTrees(tr: Track, def: TrackDef, own: Own): THREE.InstancedMesh[] {
  // One pair of meshes per kind, per 800 m tile (when there are many) (so the view's frustum leaves out those behind and to the side: an
  // instanced mesh is culled as a whole) and per distance: only the trees near the track cast shadows (the shadow
  // map covers 60 m round the car, and every instance of a shadow-casting mesh is drawn into it).
  const types = treeTypes(), groups = new Map<string, TreeSpot[]>(), spots = treeSpots(tr, def), TILE = spots.length > 1500 ? 800 : 1e9;
  for (const t of spots) {
    const key = `${t.kind}${t.near ? '+' : ''}:${Math.floor(t.x / TILE)},${Math.floor(t.z / TILE)}`;
    (groups.get(key) ?? (groups.set(key, []), groups.get(key)!)).push(t);
  }
  const meshes: THREE.InstancedMesh[] = [], mats = new Map<TreeKind, [THREE.Material, THREE.Material]>();
  for (const list of groups.values()) {
    const kind = list[0].kind, t = types[kind];
    if (!mats.has(kind)) mats.set(kind, [own(new THREE.MeshStandardMaterial({ color: t.trunkColor, roughness: 1 })),
      own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true, side: t.double ? THREE.DoubleSide : THREE.FrontSide }))]);
    const [trunkMat, crownMat] = mats.get(kind)!;
    const trunks = new THREE.InstancedMesh(t.trunk, trunkMat, list.length), crowns = new THREE.InstancedMesh(t.crown, crownMat, list.length);
    list.forEach((p, k) => {
      _q.setFromEuler(_e.set(p.tilt, p.yaw, p.tilt * 0.5));
      _m.compose(_p.set(p.x, 0, p.z), _q, _s.set(p.size, p.size * (0.9 + 0.25 * ((k * 7919) % 13) / 13), p.size));
      trunks.setMatrixAt(k, _m); crowns.setMatrixAt(k, _m);
      crowns.setColorAt(k, _c.set(t.crowns[k % t.crowns.length]).multiplyScalar(0.85 + 0.3 * ((k * 104729) % 17) / 17));
    });
    trunks.castShadow = crowns.castShadow = list[0].near;
    trunks.computeBoundingSphere(); crowns.computeBoundingSphere();
    trunks.receiveShadow = false; crowns.receiveShadow = false;
    trunks.name = crowns.name = 'trees';
    meshes.push(own(trunks), own(crowns));
  }
  for (const t of Object.values(types)) { own(t.trunk); own(t.crown); }
  return meshes;
}

// ---------------------------------------------------------------------------- buildings
// Façades: one window texture (24 m x 24 m a tile: eight storeys of twelve windows) for every building, tinted by vertex
// colour, with its lit windows as the emissive map (dark by day).
interface Facade { wall: THREE.MeshStandardMaterial; sign: THREE.MeshBasicMaterial }
function facadeMaterials(own: Own): Facade {
  const rng = mulberry32(99);
  // a tile is 24 m x 24 m: eight storeys of twelve windows (each building starts at its own window and storey of it,
  // so neighbours do not light the same windows)
  const win = (fx: number, fy: number) => [fx * 42.67 + 7, fy * 64 + 12] as const;
  const day = own(canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#e8e6e0'; g.fillRect(0, 0, w, h);
    for (let fy = 0; fy < 8; fy++) for (let fx = 0; fx < 12; fx++) {
      const [x, y] = win(fx, fy);
      g.fillStyle = '#4a5866'; g.fillRect(x, y, 29, 40);
      g.fillStyle = 'rgba(255,255,255,0.16)'; g.fillRect(x + 2, y + 2, 9, 36);
      g.fillStyle = '#8a8f96'; g.fillRect(x + 13, y, 2, 40);
    }
    g.fillStyle = 'rgba(0,0,0,0.13)'; for (let fy = 0; fy < 8; fy++) g.fillRect(0, fy * 64 + 56, w, 5);
    g.fillStyle = '#d0cec8'; g.fillRect(0, 0, 4, 4);   // the roofs' corner (uv 0..1/128)
  }));
  const lit = own(canvasTex(512, 512, (g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, 512, 512);
    for (let fy = 0; fy < 8; fy++) for (let fx = 0; fx < 12; fx++) {
      if (rng() < 0.45) continue;
      const warm = rng() < 0.7, k = 0.5 + 0.5 * rng(), [x, y] = win(fx, fy);
      g.fillStyle = warm ? `rgba(255,${190 + 30 * k | 0},${120 + 40 * k | 0},${k})` : `rgba(190,220,255,${k})`;
      g.fillRect(x, y, 29, 40);
    }
  }));
  const wall = own(new THREE.MeshStandardMaterial({ map: day, vertexColors: true, roughness: 0.75, metalness: 0.05, emissive: 0xffffff, emissiveMap: lit, emissiveIntensity: 0 }));
  wall;
  // a sign: neon tubes (an outline, a bar and a ring, tinted by the sign's colour) on a dark panel
  const neon = own(canvasTex(256, 64, (g, w, h) => {
    g.fillStyle = '#141418'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#ffffff'; g.lineWidth = 5; g.lineJoin = 'round';
    g.strokeRect(6, 6, w - 12, h - 12);
    g.lineWidth = 7; g.beginPath(); g.moveTo(62, h / 2); g.lineTo(w - 24, h / 2); g.stroke();
    g.beginPath(); g.arc(34, h / 2, 14, 0, Math.PI * 2); g.stroke();
  }, { repeat: false }));
  const sign = own(new THREE.MeshBasicMaterial({ map: neon, vertexColors: true }));
  sign;
  return { wall, sign };
}

// Boxes into one geometry (position, normal, uv, colour). u, v in metres / 24 (the façade's tile); roofs take the
// texture's plain corner.
class Boxes {
  private readonly pos: number[] = []; private readonly nor: number[] = []; private readonly uv: number[] = []; private readonly col: number[] = [];
  get empty() { return this.pos.length === 0; }
  // centre (x, z) on the ground, yaw about y, width w (local x), depth d (local z), height h
  // fit: each side face maps the whole texture once (a sign), instead of the façade's tiling
  add(x: number, z: number, yaw: number, w: number, d: number, h: number, color: number, y0 = 0, roof = true, fit = false) {
    const c = _c.set(color), cs = Math.cos(yaw), sn = Math.sin(yaw);
    const P = (lx: number, ly: number, lz: number) => [x + lx * cs + lz * sn, y0 + ly, z - lx * sn + lz * cs];
    const N = (lx: number, lz: number) => [lx * cs + lz * sn, 0, -lx * sn + lz * cs];
    const quad = (a: number[], b: number[], cc: number[], dd: number[], n: number[], u0: number, u1: number, v0: number, v1: number, shade: number) => {
      for (const [p, u, v] of [[a, u0, v0], [b, u1, v0], [cc, u1, v1], [a, u0, v0], [cc, u1, v1], [dd, u0, v1]] as const) {
        this.pos.push(...p); this.nor.push(...n); this.uv.push(u, v); this.col.push(c.r * shade, c.g * shade, c.b * shade);
      }
    };
    const hw = w / 2, hd = d / 2, T = fit ? 1 : 24, vt = fit ? 1 : h / T, u0 = fit ? 0 : Math.floor(((x * 7.31 + z * 3.17) % 12 + 12) % 12) / 12, v0 = fit ? 0 : Math.floor(((x * 1.37 - z * 5.11) % 8 + 8) % 8) / 8;
    const uw = fit ? 1 : w / T, ud = fit ? 1 : d / T;
    quad(P(-hw, 0, hd), P(hw, 0, hd), P(hw, h, hd), P(-hw, h, hd), N(0, 1), u0, u0 + uw, v0, v0 + vt, 1);
    quad(P(hw, 0, -hd), P(-hw, 0, -hd), P(-hw, h, -hd), P(hw, h, -hd), N(0, -1), u0, u0 + uw, v0, v0 + vt, 0.9);
    quad(P(hw, 0, hd), P(hw, 0, -hd), P(hw, h, -hd), P(hw, h, hd), N(1, 0), u0, u0 + ud, v0, v0 + vt, 0.95);
    quad(P(-hw, 0, -hd), P(-hw, 0, hd), P(-hw, h, hd), P(-hw, h, -hd), N(-1, 0), u0, u0 + ud, v0, v0 + vt, 0.85);
    if (roof) quad(P(-hw, h, hd), P(hw, h, hd), P(hw, h, -hd), P(-hw, h, -hd), [0, 1, 0], 0, 0.006, 0.994, 1, 0.8);
  }
  mesh(mat: THREE.Material) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true; m.castShadow = true;
    return m;
  }
}

// City blocks along a street circuit's walls: a row of blocks beyond each wall, set back further on the inside of
// bends, and a second, taller row behind; each footprint must pass clearOf.
// A block: centre on the ground, `yaw` turning local x across the track and z along it, size w x d (along) x h; a lit
// sign of height `sign` hangs on its face towards the track (0: none). `pts`: its footprint, as clearOf tested it.
export interface Block { x: number; z: number; yaw: number; w: number; d: number; h: number; color: number; sign: number; signColor: number; side: number; nx: number; nz: number; pts: [number, number][] }
export function blockSpots(tr: Track, def: TrackDef): Block[] {
  const B = def.buildings ?? KIND_BUILDINGS, rng = mulberry32(seedOf(def.id) ^ 0xc17), ds = tr.L / tr.N, out: Block[] = [];
  for (const side of [1, -1]) {
    const bar = side > 0 ? tr.barL : tr.barR, valid = side > 0 ? tr.barLValid : tr.barRValid;
    for (let i = 0; i < tr.N;) {
      const len = 16 + rng() * 26;
      if (!valid[i]) { i += 3; continue; }
      const inside = side * tr.KS[i] > 1 / 300;
      let lat = bar[i] + (inside ? 16 : 0) + (B.setback ?? 3) + rng() * 6;
      for (let row = 0; row < 2; row++) {
        const depth = 14 + rng() * 20, tall = row === 1 && rng() < B.towers;
        const h = tall ? B.tower * (0.55 + 0.45 * rng()) : B.h[0] + (B.h[1] - B.h[0]) * rng() ** 1.4 * (row ? 1.2 : 1);
        const off = side * (lat + depth / 2), cx = tr.X[i] + tr.NX[i] * off, cz = tr.Z[i] + tr.NZ[i] * off;
        const pts = footprint(cx, cz, tr.TX[i], tr.TZ[i], len / 2, side * tr.NX[i], side * tr.NZ[i], depth / 2);
        const color = B.colors[Math.floor(rng() * B.colors.length)], sign = B.signs && rng() < 0.55 ? 3 + rng() * 4 : 0;
        const signColor = SIGN_COLORS[Math.floor(rng() * SIGN_COLORS.length)];
        if (clearOf(tr, def, pts, { margin: 2, reserve: true, buildings: true })) {
          out.push({ x: cx, z: cz, yaw: Math.atan2(tr.TX[i], tr.TZ[i]) + Math.PI / 2, w: depth, d: len, h, color, sign: row === 0 ? sign : 0, signColor, side, nx: tr.NX[i], nz: tr.NZ[i], pts });
        }
        lat += depth + 6 + rng() * 10;
      }
      i += Math.max(4, Math.round((len + 3 + rng() * 6) / ds));
    }
  }
  return out;
}
// The points of a box footprint for clearOf, at most 2.5 m apart all over it (not just its edges and middle: a road
// from another stretch must not pass between them through a 30 m block). (ax, az): along; (nx, nz): across.
export function footprint(cx: number, cz: number, ax: number, az: number, halfLen: number, nx: number, nz: number, halfDepth: number) {
  const pts: [number, number][] = [], nu = Math.ceil((2 * halfLen) / 2.5), nd = Math.ceil((2 * halfDepth) / 2.5);
  for (let a = 0; a <= nu; a++) for (let b = 0; b <= nd; b++) {
    const u = -halfLen + (2 * halfLen * a) / nu, d = -halfDepth + (2 * halfDepth * b) / nd;
    pts.push([cx + ax * u + nx * d, cz + az * u + nz * d]);
  }
  return pts;
}
const SIGN_COLORS = [0xff3a8a, 0x3ad0ff, 0xffd23a, 0x9a5bff, 0xff7a2a];

function buildCity(tr: Track, def: TrackDef, f: Facade, own: Own): THREE.Object3D[] {
  const boxes = new Boxes(), signs = new Boxes();
  for (const b of blockSpots(tr, def)) {
    boxes.add(b.x, b.z, b.yaw, b.w, b.d, b.h, b.color);
    if (b.sign) {
      // a lit sign on the face towards the track, near the top
      const sx = b.x - b.side * b.nx * (b.w / 2 + 0.3), sz = b.z - b.side * b.nz * (b.w / 2 + 0.3);
      signs.add(sx, sz, b.yaw, 0.4, Math.min(b.d * 0.7, b.sign * 4), b.sign, b.signColor, Math.min(b.h - b.sign - 1, 7 + (b.x * 13.7 % 5 + 5) % 5), false, true);
    }
  }
  const out: THREE.Object3D[] = [];
  if (!boxes.empty) out.push(ownMesh(boxes.mesh(f.wall), own));
  if (!signs.empty) out.push(ownMesh(signs.mesh(f.sign), own));
  return out;
}
function ownMesh(m: THREE.Mesh, own: Own) { own(m.geometry); return m; }

// The distant city (circuits with `skyline`): a cluster of towers 2 km beyond the circuit's north side.
function buildSkyline(tr: Track, def: TrackDef, f: Facade, own: Own): THREE.Object3D[] {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity;
  for (let i = 0; i < tr.N; i++) { minX = Math.min(minX, tr.X[i]); maxX = Math.max(maxX, tr.X[i]); minZ = Math.min(minZ, tr.Z[i]); }
  const cx = (minX + maxX) / 2, rng = mulberry32(seedOf(def.id) ^ 0x5c1), boxes = new Boxes();
  const colors = def.buildings?.colors ?? [0x9aa6b2, 0xb7c0c8, 0x7f8c99, 0xc9ced3];
  for (let k = 0; k < 160; k++) {
    const x = cx - 900 + rng() * 1900, z = minZ - 1900 - rng() * 1300;
    const h = 30 + Math.pow(rng(), 2.2) * 230, w = 25 + rng() * 45, d = 25 + rng() * 45;
    boxes.add(x, z, 0, w, d, h, colors[k % colors.length]);
  }
  const m = boxes.mesh(f.wall);
  m.castShadow = m.receiveShadow = false;
  return [ownMesh(m, own)];
}

// ---------------------------------------------------------------------------- hills
// A ring of hills on the horizon, beyond the circuit (TrackDef.hills: their greatest height, m), coloured for the
// place: wooded, dry, or dunes. The fog melts it into the sky.
function buildHills(tr: Track, def: TrackDef, own: Own): THREE.Object3D {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < tr.N; i++) { minX = Math.min(minX, tr.X[i]); maxX = Math.max(maxX, tr.X[i]); minZ = Math.min(minZ, tr.Z[i]); maxZ = Math.max(maxZ, tr.Z[i]); }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, rc = Math.hypot(maxX - minX, maxZ - minZ) / 2;
  const r0 = Math.min(rc + 650, 2400), r1 = r0 + 700, H = Math.max(12, def.hills ?? 20);
  const rng = mulberry32(seedOf(def.id) ^ 0x4111), seg = 192;
  const waves = Array.from({ length: 6 }, (_, k) => ({ f: [1, 2, 3, 5, 8, 13][k], a: [1, 0.6, 0.45, 0.3, 0.18, 0.1][k], p: rng() * Math.PI * 2 }));
  const prof = (a: number) => { let v = 0, n = 0; for (const w of waves) { v += w.a * Math.sin(a * w.f + w.p); n += w.a; } return 0.5 + 0.5 * v / n; };
  const pal: Record<SceneKind, [number, number]> = {
    forest: [0x3c5a34, 0x2e4a2c], park: [0x56703e, 0x40583a], country: [0x6a7a48, 0x56683e], dry: [0x9a8a5a, 0x7a6e4c],
    city: [0x6a7262, 0x5a6258], desert: [0xc8a874, 0xb89464], dunes: [0xbfae7e, 0x8c9460],
  };
  const [lo, hi] = pal[def.scene], rows = [0, 0.35, 0.7, 1], hRow = [0, 0.75, 1, 0.55];
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  for (let k = 0; k <= seg; k++) {
    const a = (k / seg) * Math.PI * 2, h1 = prof(a), h2 = prof(a * 1 + 1.7);
    for (let r = 0; r < rows.length; r++) {
      const rad = r0 + (r1 - r0) * rows[r], hh = H * hRow[r] * (r === 2 ? h1 : 0.5 * (h1 + h2)) - 2;
      pos.push(cx + Math.cos(a) * rad, hh, cz + Math.sin(a) * rad);
      _c.set(r >= 2 ? hi : lo); col.push(_c.r, _c.g, _c.b);
    }
  }
  const R = rows.length;
  for (let k = 0; k < seg; k++) for (let r = 0; r < R - 1; r++) {
    const a = k * R + r, b = a + 1, c = a + R, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  const m = new THREE.Mesh(own(g), own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide })));
  m.name = 'hills';
  return m;
}

// ---------------------------------------------------------------------------- fences
// Catch fences on the walls: all round a street circuit; elsewhere along the walls behind gravel traps and the start
// straight. A see-through mesh 3 m high above the wall's cap, posts every 3 m (alpha-tested).
function buildFences(tr: Track, def: TrackDef, own: Own): THREE.Object3D[] {
  const tex = own(canvasTex(128, 128, (g) => {
    g.clearRect(0, 0, 128, 128);
    g.strokeStyle = 'rgba(70,74,80,0.95)'; g.lineWidth = 1.5;
    for (let k = -128; k < 256; k += 7) {
      g.beginPath(); g.moveTo(0, k); g.lineTo(128, k + 128); g.stroke();
      g.beginPath(); g.moveTo(0, k); g.lineTo(128, k - 128); g.stroke();
    }
    g.fillStyle = '#5b6068'; g.fillRect(0, 0, 128, 6);     // the post (along the canvas' y: the track)
    g.fillRect(122, 0, 6, 128);                             // the top rail (u = 1)
  }));
  const mat = own(new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.5 }));
  const ds = tr.L / tr.N, nearLine = Math.round(400 / ds), out: THREE.Object3D[] = [];
  for (const side of [1, -1]) {
    const bar = side > 0 ? tr.barL : tr.barR, valid = side > 0 ? tr.barLValid : tr.barRValid, gravel = side > 0 ? tr.gravelL : tr.gravelR;
    const mask = new Uint8Array(tr.N);
    for (let i = 0; i < tr.N; i++) {
      const k = Math.min(i, tr.N - i);
      mask[i] = valid[i] && (def.street || gravel[i] || k < nearLine) ? 1 : 0;
    }
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let i = 0; i <= tr.N; i++) {
      const k = i % tr.N, o = side * (bar[k] + 0.25), x = tr.X[k] + tr.NX[k] * o, z = tr.Z[k] + tr.NZ[k] * o, v = (i === tr.N ? tr.L : tr.S[k]) / 3;
      pos.push(x, 1.0, z, x, 4.0, z); uv.push(0, v, 1, v);
      if (i < tr.N && mask[k] && mask[(k + 1) % tr.N]) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    if (!idx.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.Mesh(own(g), mat);
    m.name = 'fence';
    out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------------------- bridges
// An advertising bridge over the middle of the longest straights (at most two, not on the start straight): a deck 7.5 m
// clear of the road on two legs beyond the walls. It must not stand over another stretch of the lap.
export interface Bridge { i: number; wl: number; wr: number; legs: [number, number][]; deck: [number, number][] }
export const BRIDGE_CLEAR = 7.5;   // m from the road to the deck's underside
export function bridgeSpots(tr: Track, def: TrackDef): Bridge[] {
  const ds = tr.L / tr.N, runs: { a: number; b: number }[] = [], out: Bridge[] = [];
  let a = -1;
  for (let k = 0; k <= tr.N; k++) {
    const i = k % tr.N, straight = k < tr.N && Math.abs(tr.KS[i]) < 1 / 1500 && tr.barLValid[i] && tr.barRValid[i];
    if (straight && a < 0) a = k;
    if (!straight && a >= 0) { if ((k - a) * ds > 280) runs.push({ a, b: k }); a = -1; }
  }
  runs.sort((p, q) => q.b - q.a - (p.b - p.a));
  for (const r of runs) {
    if (out.length === 2) break;
    const i = wrapI(Math.round((r.a + r.b) / 2), tr.N);
    if (Math.min(i, tr.N - i) * ds < 500) continue;                    // not by the start gantry
    const wl = tr.barL[i] + 1.4, wr = tr.barR[i] + 1.4;
    const deck: [number, number][] = [];
    for (let o = -wr; o <= wl; o += 2) for (const along of [-1.5, 1.5]) deck.push([tr.X[i] + tr.NX[i] * o + tr.TX[i] * along, tr.Z[i] + tr.NZ[i] * o + tr.TZ[i] * along]);
    const legs = [wl, -wr].map((o) => [tr.X[i] + tr.NX[i] * o, tr.Z[i] + tr.NZ[i] * o] as [number, number]);
    // the legs stand clear of every wall; the deck may pass over only this stretch
    if (!clearOf(tr, def, legs, { margin: 0.6, reserve: true, buildings: true }) || !clearOf(tr, def, deck, { skip: [i - 60, i + 60], margin: 1 })) continue;
    out.push({ i, wl, wr, legs, deck });
  }
  return out;
}

function buildBridges(tr: Track, def: TrackDef, own: Own): THREE.Object3D[] {
  const spots = bridgeSpots(tr, def);
  if (!spots.length) return [];
  const banner = own(canvasTex(512, 64, (g, w, h) => {
    g.fillStyle = '#16365e'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#f2f2ee'; g.font = 'bold 40px system-ui, sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'center';
    g.fillText('VELOCITA', w * 0.25, h / 2 + 2); g.fillStyle = '#f0b323'; g.fillText('APEX FUEL', w * 0.75, h / 2 + 2);
    g.fillStyle = '#d8262b'; g.fillRect(0, h - 6, w, 6);
  }, { repeat: false }));
  const steel = own(new THREE.MeshStandardMaterial({ color: 0x8a9098, roughness: 0.5, metalness: 0.5 }));
  const face = own(new THREE.MeshStandardMaterial({ map: banner, roughness: 0.6 }));
  const batch = new Batch(), M = new THREE.Matrix4(), L = new THREE.Matrix4();
  for (const { i, wl, wr } of spots) {
    // local x along the left normal, z along the track
    M.compose(_p.set(tr.X[i], 0, tr.Z[i]), _q.setFromEuler(_e.set(0, Math.atan2(-tr.NZ[i], tr.NX[i]), 0)), _s.set(1, 1, 1));
    const deckGeo = new THREE.BoxGeometry(wl + wr, 2.2, 2.4), legGeo = new THREE.BoxGeometry(1.1, BRIDGE_CLEAR + 2.2, 1.6);
    batch.add(deckGeo, L.multiplyMatrices(M, L.makeTranslation((wl - wr) / 2, BRIDGE_CLEAR + 1.1, 0)), [steel, steel, steel, steel, face, face]);
    for (const o of [wl, -wr]) batch.add(legGeo, L.multiplyMatrices(M, L.makeTranslation(o, (BRIDGE_CLEAR + 2.2) / 2, 0)), steel);
    deckGeo.dispose(); legGeo.dispose();
  }
  return batch.build(new THREE.Group()).map((m) => { own(m.geometry); return m; });
}

// ---------------------------------------------------------------------------- grid
// The starting grid's slots painted on the start straight (raceGeometry.ts gridSlots, as the race weekends use them):
// a bar across in front of each slot with short arms back, in the lines' paint.
function buildGridMarks(tr: Track, lineMat: THREE.Material, own: Own): THREE.Object3D {
  const pos: number[] = [], idx: number[] = [];
  const quad = (s0: number, s1: number, l0: number, l1: number) => {
    const base = pos.length / 3, c = [[s0, l0], [s1, l0], [s1, l1], [s0, l1]].map(([s, l]) => pointAt(tr, s, l));
    for (const p of c) pos.push(p.x, 0.0045, p.z);
    // wound to face up (the material is double-sided, and a back face's normal is turned down)
    const up = (c[2].x - c[0].x) * (c[1].z - c[0].z) - (c[2].z - c[0].z) * (c[1].x - c[0].x) > 0;
    idx.push(...(up ? [base, base + 2, base + 1, base, base + 3, base + 2] : [base, base + 1, base + 2, base, base + 2, base + 3]));
  };
  for (const g of gridSlots(tr, 20)) {
    const front = g.s + 2.9;
    quad(front - 0.16, front, g.lat - 1.25, g.lat + 1.25);
    quad(front - 1.1, front - 0.16, g.lat - 1.25, g.lat - 1.1);
    quad(front - 1.1, front - 0.16, g.lat + 1.1, g.lat + 1.25);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx); geo.computeVertexNormals();
  const m = new THREE.Mesh(own(geo), lineMat);
  m.receiveShadow = true; m.name = 'grid';
  return m;
}
