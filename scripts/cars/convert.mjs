// Converts a downloaded car model (glTF binary) into the game asset in public/cars/<id>/model.glb: turned to the
// game's axes (x left, y up, z forward), scaled and placed so its wheels sit on the car spec's axles, split into the
// parts the game moves, simplified, with WebP textures and meshopt-compressed geometry.
//
//   node scripts/cars/convert.mjs <id> <source.glb> [<textures dir>]
//
// The sources are not in the repository (50-80 MB each). Download them from Sketchfab ("Download 3D model", glTF
// format, which gives a .glb in source/ and a textures/ directory next to it):
//   gt3    "Mercedes-AMG GT3 | www.vecarz.com" by Vecarz (heynic), CC BY-NC-SA 4.0
//          https://sketchfab.com/3d-models/mercedes-amg-gt3-wwwvecarzcom-6a3f7e3455064721b74b7f0b66427a07
//          node scripts/cars/convert.mjs gt3 <dir>/source/amg_evo_3.glb <dir>/textures
//          (the livery, banner and tyre textures are only in textures/: the .glb leaves those materials untextured)
//   lcgt3  "Mercedes-AMG GT3 Red Bull Racing" by VTX (VTX_car), CC BY-NC-SA 4.0
//          https://sketchfab.com/3d-models/mercedes-amg-gt3-red-bull-racing-035f061cb6624effbc483d5f9b5ecaba
//          node scripts/cars/convert.mjs lcgt3 <dir>/source/mercedes_benz_amg_gt3_red_bull.glb
// The licence files beside each output (LICENSE.md) list the changes made here, as the licence requires: update
// them with any change to what this does. Check the result in the game (wheels, steering wheel, driver camera) and
// with test/carModels.test.ts; scripts/cars/inspect.mjs prints a file's scene graph, materials and textures.
//
// Output nodes (the game finds them by name; carModels.ts in src/):
//   body                 everything that moves with the car's body
//   wheel_FL/FR/RL/RR    tyre, rim and brake disc: spun and steered
//   hub_FL/FR/RL/RR      brake calipers: steered, not spun
//   steering_wheel       turned about its own z axis
//   brake_light          its own material, lit while braking
// Each moving part carries extras.frame = { origin, rake }: where the part's own origin sits in the body (wheel
// centre, steering-wheel centre) and the steering wheel's rake. The node's own transform can differ from that frame
// (quantization moves it), so the game places a part by frame^-1 * node transform. extras.grip on the steering wheel
// is the radius at which the hands hold it (m), extras.radius on a wheel its tyre's radius (m).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, EXTTextureWebP, KHRMaterialsClearcoat, KHRMaterialsEmissiveStrength,
  KHRMaterialsSpecular, KHRMaterialsTransmission } from '@gltf-transform/extensions';
import { compactPrimitive, dedup, join, meshopt, prune, textureCompress, weldPrimitive } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = pathJoin(dirname(fileURLToPath(import.meta.url)), '../..');
const CORNERS = ['FL', 'FR', 'RL', 'RR'];

// ---------------------------------------------------------------------------------------------------------------
// Per-car setup. `target`: the spec's axles (src/cars.ts; lcgt3's come from LibreCorsa's AMG data through lcBody):
// the axles land at z = zFront / zRear and the road under the tyres at y = -comHeight (the centre of mass is the
// origin).
// `turn`: degrees about y that bring the source's front to +z. `part(nodeNames, material)` sorts each source mesh:
// 'body' (detail 'ext' or 'int'), 'wheel' (spun; 'tyre' also locates the hubs), 'hub' (steered only), 'steer'
// ('steerRim' also locates the steering axis), 'brake' or null to drop it. 'wheel'/'hub' meshes are split into the
// four corners triangle by triangle.
// ---------------------------------------------------------------------------------------------------------------
const CARS = {
  gt3: {
    target: { zFront: 1.378, zRear: -1.272, wheelRadius: 0.345, comHeight: 0.40 },
    turn: 0,
    part(names, mat) {
      const has = (re) => names.some((n) => re.test(n));
      if (has(/^RIM_BLUR|pistons|^CINTURE_(ON|OFF)$|^MOTEC2$|EXT_Banner002|^LED_RPM_LIMITER_1$|^LED_RPM_TC$|^auxiliary_light_interior$/)) return null;
      if (has(/^AMG_GT3_DISPALY_MESH\d/)) return null;   // display overlays stacked on the screen (one is kept)
      if (has(/^TYRE_/)) return ['tyre'];
      if (has(/^RIM_|^Disc_/)) return ['wheel'];
      if (has(/^SUSP_/)) return ['hub'];
      if (has(/^INT_Steer001$/)) return ['steerRim'];
      if (has(/^STEER_HR$/)) return ['steer'];
      if (has(/^EXT_Emissive_Brakelights$/)) return ['brake'];
      if (/Windows|Windshield/.test(mat)) return ['glass'];
      if (has(/^COCKPIT_HR$/) || mat.startsWith('INT_')) return ['body', 'int'];
      return ['body', 'ext'];
    },
    // The .glb leaves these untextured and flat grey: the livery and other textures are in textures/, and the
    // rest get colours.
    materials(m, tex) {
      const name = m.getName();
      const set = (color, metal, rough, extra = {}) => {
        m.setBaseColorFactor([...color, extra.alpha ?? 1]).setMetallicFactor(metal).setRoughnessFactor(rough);
        if (extra.alpha !== undefined) m.setAlphaMode('BLEND');
        if (extra.emissive) m.setEmissiveFactor(extra.emissive);
        if (extra.double) m.setDoubleSided(true);
      };
      const lin = (hex) => [hex >> 16, (hex >> 8) & 255, hex & 255].map((c) => (c / 255) ** 2.2);
      if (/^EXT_Carpaint_Inst/.test(name)) { set([1, 1, 1], 0.1, 0.35); m.setBaseColorTexture(tex('EXT_Skin_Colour.png', 'livery')); return; }
      if (name === 'MIRROR') { set(lin(0x8a9096), 1, 0.08); m.setBaseColorTexture(null); return; }
      if (/^EXT_Banner/.test(name)) { set([1, 1, 1], 0, 0.5); m.setBaseColorTexture(tex('EXT_Banner_Colour.png', 't_banner')); return; }
      if (name === 'EXT_Logo') { set([1, 1, 1], 0.3, 0.4); m.setBaseColorTexture(tex('ext_decals_colour.png', 't_decals')); return; }
      if (/Windows|Windshield/.test(name)) { set(lin(0x1a222b), 0.6, 0.08, { alpha: 0.45 }); m.setDoubleSided(false); return; }
      if (/Glass/.test(name) && !m.getBaseColorTexture()) { set(lin(0x20262c), 0.5, 0.1, { alpha: 0.5 }); return; }
      if (/Carbon/.test(name)) { set(lin(0x1c1e22), 0.4, 0.35); return; }
      if (/Chrome|Wing_Metal/.test(name)) { set(lin(0xb0b4ba), 1, 0.25); return; }
      if (/Calipers/.test(name)) { set(lin(0xc81e1e), 0.3, 0.4); return; }
      if (/Grid|Radiators/.test(name)) { set(lin(0x101113), 0.3, 0.6); return; }
      if (/Exhaust/.test(name)) { set(lin(0x5a5550), 0.8, 0.4); return; }
      if (/Lighthouse/.test(name)) { set(lin(0x2a2d31), 0.8, 0.2); return; }
      if (/Wheelhouse|Hooks|Mechanics/.test(name) && !m.getBaseColorTexture()) { set(lin(0x17181a), 0.2, 0.7); return; }
      if (/^INT_/.test(name) && !m.getBaseColorTexture()) { set(lin(name === 'INT_Seat' ? 0x2a2c30 : 0x1a1b1e), 0.1, 0.7); return; }
      if (/^INT_Steer/.test(name) && !m.getBaseColorTexture()) { set(lin(0x16171a), 0.1, 0.6); return; }
      if (name === 'amg_gt3_tyres') { set([1, 1, 1], 0, 0.85); return; }
      if (name === 'amg_gt3_rims') { set([1, 1, 1], 0.6, 0.35); return; }
      if (!m.getBaseColorTexture()) set(lin(0x2a2c30), 0.2, 0.6);
      else m.setRoughnessFactor(Math.min(m.getRoughnessFactor(), 0.7));
    },
  },
  lcgt3: {
    target: { zFront: 1.378, zRear: -1.272, wheelRadius: 0.34625, comHeight: 0.40 },
    turn: -90,
    detail: { ext: [0.004, 0.2], wheel: [0.006, 0.2], hub: [0.02, 0.15], steer: [0.004, 0.3] },   // a denser mesh
    part(names, mat) {
      if (mat === 'WorldGridMaterial') return null;   // an engine placeholder material
      if (/windows_Glass|Windows_Stickers/.test(mat)) return ['glass'];   // the stickers are a dark tint film over the glass
      if (/Tyre_Inst/.test(mat)) return ['tyre'];
      if (/Rim_Inst|Brake_Disc/.test(mat)) return ['wheel'];
      if (/Caliper_Inst/.test(mat)) return ['hub'];
      if (/Steering_Wheel/.test(mat)) return [names.includes('Object_157') ? 'steerRim' : 'steer'];
      if (/Engine_Components|Suspension/.test(mat)) return ['body', 'hidden'];   // mostly out of sight (engine bay, arches)
      if (/Cockpit|Interior|Seat|Pedals|Net_Share|stitches|Interactive_Lights/.test(mat)) return ['body', 'int'];
      if (mat === 'MI_Mercedes_AMG_GT3_Evo_Lights') return ['lights'];   // split: rear ones are the brake light
      return ['body', 'ext'];
    },
    materials(m) {
      // No transmission (an extra render pass), clearcoat or specular extensions: plain metal/rough with the
      // game's environment map.
      for (const e of m.listExtensions()) m.setExtension(e.extensionName, null);
      const name = m.getName();
      if (/Windows_Stickers/.test(name)) m.setDoubleSided(false);
      if (/windows_Glass/.test(name)) m.setBaseColorFactor([0.1, 0.12, 0.14, 0.45]).setMetallicFactor(0.6).setRoughnessFactor(0.08).setBaseColorTexture(null).setDoubleSided(false);
      if (/Lights_Glass/.test(name)) m.setBaseColorFactor([0.09, 0.09, 0.09, 0.3]);
      if (/Livery/.test(name)) { m.setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(0.15).setRoughnessFactor(0.3); m.getBaseColorTexture()?.setName('livery'); }
      if (/Carbon_Fiber/.test(name)) m.setNormalTexture(null);   // tiling weave, invisible at this size
    },
  },
};

// The simplifier's error limit, as a share of each part's size, and the share of triangles it aims for (a car's
// `detail` overrides some). The driver camera looks at the cabin from a few centimetres: it (and the steering
// wheel) is barely simplified, and the budget comes from what is never seen up close ('hidden': engine bay,
// suspension, the interior behind the seats).
const DETAIL = { ext: [0.0015, 0.3], cabin: [0.0004, 0.6], glass: [0.0005, 0.6], hidden: [0.05, 0.03], wheel: [0.004, 0.25],
  hub: [0.01, 0.2], steer: [0.0015, 0.6], brake: [0.01, 0.5] };
// The cabin, in the game's body coordinates: everything the driver camera sees close up (dash, cage, pillars, door
// cards, mirrors, roof). Interior outside it counts as hidden.
const CABIN = { x: 1.12, y: 0.12, z: [-1.15, 0.8] };
const CABIN_CENTRE = [0, 0.45, -0.45];   // inside the glass, for telling its outer faces from inner ones

// ---------------------------------------------------------------------------------------------------------------
const [id, src, texDir] = process.argv.slice(2);
const car = CARS[id];
if (!car || !src) {
  console.error('usage: node scripts/cars/convert.mjs <' + Object.keys(CARS).join('|') + '> <source.glb> [<textures dir>]');
  process.exit(1);
}
await MeshoptDecoder.ready; await MeshoptEncoder.ready; await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(src);
const root = doc.getRoot(), buffer = root.listBuffers()[0];
const triCount = (prims) => prims.reduce((a, p) => a + (p.getIndices() ?? p.getAttribute('POSITION')).getCount() / 3, 0);
const srcTris = triCount(root.listMeshes().flatMap((m) => m.listPrimitives()));

// Loose texture files, for materials the .glb leaves untextured. They are stored bottom row first (as DirectX
// textures are), so they are flipped.
const loose = new Map();
const pending = [];
const tex = (file, name) => {
  if (!loose.has(file)) {
    const t = doc.createTexture(name).setMimeType('image/png');
    pending.push(sharp(readFileSync(pathJoin(texDir, file))).flip().png().toBuffer().then((b) => t.setImage(b)));
    loose.set(file, t);
  }
  return loose.get(file);
};
for (const m of root.listMaterials()) car.materials(m, tex);
await Promise.all(pending);

// --- 1. Collect every triangle in game axes (before scaling), sorted into soups by part and material. -------------
const turn = (car.turn * Math.PI) / 180, ct = Math.cos(turn), st = Math.sin(turn);
// rotation about y: x' = x cos + z sin, z' = -x sin + z cos
const rot = (x, y, z) => [x * ct + z * st, y, -x * st + z * ct];
const soups = new Map();   // key -> { kind, detail, material, pos: [], nrm: [], uv: [] }
const soup = (kind, detail, material) => {
  const key = `${kind}|${detail}|${root.listMaterials().indexOf(material)}`;
  if (!soups.has(key)) soups.set(key, { kind, detail, material, pos: [], nrm: [], uv: [] });
  return soups.get(key);
};
const mul = (m, x, y, z, w) => [m[0] * x + m[4] * y + m[8] * z + m[12] * w, m[1] * x + m[5] * y + m[9] * z + m[13] * w, m[2] * x + m[6] * y + m[10] * z + m[14] * w];
for (const scene of root.listScenes()) scene.traverse((node) => {
  const mesh = node.getMesh();
  if (!mesh) return;
  const names = [];
  for (let n = node; n; n = n.getParentNode()) names.push(n.getName());
  const world = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== 4) continue;
    const material = prim.getMaterial();
    const sorted = car.part(names, material?.getName() ?? '');
    if (!sorted) continue;
    const [kind, detail = kind === 'steerRim' ? 'steer' : kind] = sorted;
    const s = soup(kind, detail, material);
    const P = prim.getAttribute('POSITION'), N = prim.getAttribute('NORMAL'), T = prim.getAttribute('TEXCOORD_0'), I = prim.getIndices();
    const count = I ? I.getCount() : P.getCount(), a = [], b = [], c = [];
    for (let k = 0; k < count; k++) {
      const i = I ? I.getScalar(k) : k;
      P.getElement(i, a); const p = rot(...mul(world, a[0], a[1], a[2], 1));
      s.pos.push(...p);
      if (N) { N.getElement(i, b); const n = rot(...mul(world, b[0], b[1], b[2], 0)), l = Math.hypot(...n) || 1; s.nrm.push(n[0] / l, n[1] / l, n[2] / l); }
      else s.nrm.push(0, 1, 0);
      if (T) { T.getElement(i, c); s.uv.push(c[0], c[1]); } else s.uv.push(0, 0);
    }
  }
});

// --- 2. Split the wheels and hubs into corners, and find each hub from its tyre. ---------------------------------
const box = () => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
const grow = (b, x, y, z) => { const v = [x, y, z]; for (let k = 0; k < 3; k++) { b.min[k] = Math.min(b.min[k], v[k]); b.max[k] = Math.max(b.max[k], v[k]); } };
const tyreBox = box();
for (const s of soups.values()) if (s.kind === 'tyre') for (let i = 0; i < s.pos.length; i += 3) grow(tyreBox, s.pos[i], s.pos[i + 1], s.pos[i + 2]);
const zMid = (tyreBox.min[2] + tyreBox.max[2]) / 2;
const corner = (x, z) => (z > zMid ? 0 : 2) + (x > 0 ? 0 : 1);   // x is left: FL, FR, RL, RR
const tyreBoxes = CORNERS.map(box);
for (const [key, s] of [...soups]) {
  if (!['tyre', 'wheel', 'hub', 'lights'].includes(s.kind)) continue;
  soups.delete(key);
  for (let t = 0; t < s.pos.length; t += 9) {
    const cx = (s.pos[t] + s.pos[t + 3] + s.pos[t + 6]) / 3, cz = (s.pos[t + 2] + s.pos[t + 5] + s.pos[t + 8]) / 3;
    let d;
    if (s.kind === 'lights') d = cz < tyreBox.min[2] ? soup('brake', 'brake', s.material) : soup('body', 'ext', s.material);
    else {
      const k = corner(cx, cz);
      d = soup(`${s.kind === 'hub' ? 'hub' : 'wheel'}_${CORNERS[k]}`, s.kind === 'hub' ? 'hub' : 'wheel', s.material);
      if (s.kind === 'tyre') for (let v = t; v < t + 9; v += 3) grow(tyreBoxes[k], s.pos[v], s.pos[v + 1], s.pos[v + 2]);
    }
    d.pos.push(...s.pos.slice(t, t + 9)); d.nrm.push(...s.nrm.slice(t, t + 9)); d.uv.push(...s.uv.slice((t / 9) * 6, (t / 9) * 6 + 6));
  }
}
const centre = (b) => b.min.map((v, k) => (v + b.max[k]) / 2);
const hubs = tyreBoxes.map(centre), radii = tyreBoxes.map((b) => (b.max[1] - b.min[1] + b.max[2] - b.min[2]) / 4);

// --- 3. Scale and place: the wheelbase is the spec's, front axle on zFront, hubs at wheelRadius - comHeight. ------
const tg = car.target;
const zf = (hubs[0][2] + hubs[1][2]) / 2, zr = (hubs[2][2] + hubs[3][2]) / 2;
const scale = (tg.zFront - tg.zRear) / (zf - zr);
const ground = tyreBoxes.reduce((a, b) => a + b.min[1], 0) / 4;   // the road, under the tyres
const off = [-(hubs.reduce((a, h) => a + h[0], 0) / 4) * scale, -tg.comHeight - ground * scale, tg.zFront - zf * scale];
const place = (p) => p.map((v, k) => v * scale + off[k]);
for (const s of soups.values()) for (let i = 0; i < s.pos.length; i += 3) {
  const p = place(s.pos.slice(i, i + 3));
  s.pos[i] = p[0]; s.pos[i + 1] = p[1]; s.pos[i + 2] = p[2];
}
const hubsG = hubs.map(place);

// --- 3b. Sort the body by where the driver camera can see it, and keep only the glass faces that face out: seen
// from the seat the glass is then clear (single-sided), and from outside it looks as before. (Both models have an
// inner layer of glass, or faces wound inwards, which tinted the view out twice over.)
for (const [key, s] of [...soups]) {
  if (s.kind !== 'body' && s.kind !== 'glass') continue;
  soups.delete(key);
  for (let t = 0; t < s.pos.length; t += 9) {
    const P = s.pos, c = [0, 1, 2].map((k) => (P[t + k] + P[t + 3 + k] + P[t + 6 + k]) / 3);
    const inCabin = Math.abs(c[0]) < CABIN.x && c[1] > CABIN.y && c[2] > CABIN.z[0] && c[2] < CABIN.z[1];
    let detail;
    if (s.kind === 'glass') {
      const u = [0, 1, 2].map((k) => P[t + 3 + k] - P[t + k]), v = [0, 1, 2].map((k) => P[t + 6 + k] - P[t + k]);
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      if (n[0] * (c[0] - CABIN_CENTRE[0]) + n[1] * (c[1] - CABIN_CENTRE[1]) + n[2] * (c[2] - CABIN_CENTRE[2]) <= 0) continue;
      detail = 'glass';
    } else detail = inCabin ? 'cabin' : s.detail === 'int' ? 'hidden' : s.detail;
    const d = soup('body', detail, s.material);
    d.pos.push(...P.slice(t, t + 9)); d.nrm.push(...s.nrm.slice(t, t + 9)); d.uv.push(...s.uv.slice((t / 9) * 6, (t / 9) * 6 + 6));
  }
}

// --- 4. The steering wheel's axis: the direction most of its surface faces (the largest principal axis of its
// area-weighted face normals; the shape alone is ambiguous, a GT3 wheel being nearly as deep as it is tall). -------
const rim = [...soups.values()].filter((s) => s.kind === 'steerRim').flatMap((s) => s.pos);
const NN = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
for (let t = 0; t < rim.length; t += 9) {
  const u = [0, 1, 2].map((k) => rim[t + 3 + k] - rim[t + k]), v = [0, 1, 2].map((k) => rim[t + 6 + k] - rim[t + k]);
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], a = Math.hypot(...n) || 1;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) NN[r][c] += (n[r] * n[c]) / a;   // area * unit n * unit n
}
for (const s of soups.values()) if (s.kind === 'steerRim') s.kind = 'steer';
const n = rim.length / 3, mean = [0, 0, 0];
for (let i = 0; i < rim.length; i += 3) for (let k = 0; k < 3; k++) mean[k] += rim[i + k] / n;
const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
for (let i = 0; i < rim.length; i += 3) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r][c] += (rim[i + r] - mean[r]) * (rim[i + c] - mean[c]) / n;
const axis = eigenvector(NN, 'largest');
if (process.env.VERBOSE) console.log('  rim shape axis (smallest spread):', eigenvector(C, 'smallest').map((v) => v.toFixed(3)).join(', '));
if (axis[2] < 0) axis.forEach((v, k) => (axis[k] = -v));
const rake = Math.atan2(-axis[1], axis[2]);   // the mount's rotation about x (the top leans away from the driver)
const cr = Math.cos(rake), sr = Math.sin(rake);
const toWheel = (x, y, z) => [x, y * cr + z * sr, -y * sr + z * cr];   // body -> steering-wheel axes (rotate by -rake about x)
const toBody = (x, y, z) => [x, y * cr - z * sr, y * sr + z * cr];
const rimBox = box();
for (let i = 0; i < rim.length; i += 3) grow(rimBox, ...toWheel(rim[i], rim[i + 1], rim[i + 2]));
const steerCentre = toBody(...centre(rimBox));
const grip = ((rimBox.max[0] - rimBox.min[0]) / 2) * 0.86;

// --- 4b. Whatever is mounted on the steering wheel but sits in another mesh (labels, screws, buttons, knobs,
// paddles, lights: the Red Bull model keeps those in its interior meshes) turns with it: each connected piece of
// the body that lies wholly inside the wheel's own box (its rim's extent, a little margin round the edge, and its
// depth from the face to the back of the paddles) moves to the steering wheel. Whole pieces, so a label is never
// cut in half; nothing reaching out of the box (column, stalks, the dash display behind) moves.
const local = (x, y, z) => toWheel(x, y, z);
const rimDepth = car.steerDepth ?? [rimBox.min[2], rimBox.max[2]];
const inWheel = (p) => p[0] > rimBox.min[0] - 0.01 && p[0] < rimBox.max[0] + 0.01 && p[1] > rimBox.min[1] - 0.01 &&
  p[1] < rimBox.max[1] + 0.01 && p[2] > rimDepth[0] - 0.005 && p[2] < rimDepth[1] + 0.005;
const moved = new Map();
for (const s of [...soups.values()]) {
  if (s.kind !== 'body') continue;
  const nTri = s.pos.length / 9, parent = new Int32Array(nTri).map((_, i) => i), byVertex = new Map();
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  for (let t = 0; t < nTri; t++) for (let v = 0; v < 3; v++) {
    const o = t * 9 + v * 3, key = `${Math.round(s.pos[o] * 1e5)},${Math.round(s.pos[o + 1] * 1e5)},${Math.round(s.pos[o + 2] * 1e5)}`;
    const other = byVertex.get(key);
    if (other === undefined) byVertex.set(key, t); else parent[find(t)] = find(other);
  }
  const outside = new Set();
  for (let t = 0; t < nTri; t++) for (let v = 0; v < 3; v++) {
    const o = t * 9 + v * 3;
    if (!inWheel(local(s.pos[o], s.pos[o + 1], s.pos[o + 2]))) outside.add(find(t));
  }
  const keep = { pos: [], nrm: [], uv: [] }, take = soup('steer', 'steer', s.material);
  for (let t = 0; t < nTri; t++) {
    const d = outside.has(find(t)) ? keep : take;
    d.pos.push(...s.pos.slice(t * 9, t * 9 + 9)); d.nrm.push(...s.nrm.slice(t * 9, t * 9 + 9)); d.uv.push(...s.uv.slice(t * 6, t * 6 + 6));
    if (d === take) moved.set(s.material?.getName(), (moved.get(s.material?.getName()) ?? 0) + 1);
  }
  Object.assign(s, keep);
}
console.log(`  steering wheel ${[0, 1, 2].map((k) => (rimBox.max[k] - rimBox.min[k]).toFixed(3)).join(' x ')} m (width, height, depth); moved onto it: ${[...moved].map(([m, n]) => `${m} ${n}`).join(', ') || 'nothing'}`);

// --- 5. Build the output scene: one node per part, one primitive per material. -----------------------------------
const frames = { body: { origin: [0, 0, 0], rake: 0 } };
CORNERS.forEach((c, k) => { frames[`wheel_${c}`] = frames[`hub_${c}`] = { origin: hubsG[k], rake: 0 }; });
frames.steering_wheel = { origin: steerCentre, rake };
frames.brake_light = frames.body;
const partOf = (kind) => (kind === 'steer' ? 'steering_wheel' : kind === 'brake' ? 'brake_light' : kind);
const scene = doc.createScene('car');
const nodes = new Map();
const brakeMats = new Map();
const f32 = (a) => new Float32Array(a);
for (const s of soups.values()) {
  if (!s.pos.length) continue;
  const name = partOf(s.kind), fr = frames[name];
  if (!nodes.has(name)) {
    const node = doc.createNode(name).setMesh(doc.createMesh(name)).setTranslation(fr.origin)
      .setRotation([Math.sin(fr.rake / 2), 0, 0, Math.cos(fr.rake / 2)]).setExtras({ frame: fr });
    if (name === 'steering_wheel') node.setExtras({ frame: fr, grip });
    if (name.startsWith('wheel_')) node.setExtras({ frame: fr, radius: radii[CORNERS.indexOf(name.slice(6))] * scale });
    scene.addChild(node); nodes.set(name, node);
  }
  // vertices into the part's own frame
  const pos = [], nrm = [];
  for (let i = 0; i < s.pos.length; i += 3) {
    pos.push(...toFrame(fr, s.pos[i] - fr.origin[0], s.pos[i + 1] - fr.origin[1], s.pos[i + 2] - fr.origin[2]));
    nrm.push(...toFrame(fr, s.nrm[i], s.nrm[i + 1], s.nrm[i + 2]));
  }
  let material = s.material;
  if (s.kind === 'brake') {   // its own material, so lighting it does not light the tail lights
    if (!brakeMats.has(material)) brakeMats.set(material, material.clone().setName('brake_light'));
    material = brakeMats.get(material);
  }
  const prim = doc.createPrimitive().setMaterial(material)
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(f32(pos)).setBuffer(buffer))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(f32(nrm)).setBuffer(buffer));
  if (material && listTextured(material)) prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(f32(s.uv)).setBuffer(buffer));
  prim.setExtras({ detail: s.detail });
  nodes.get(name).getMesh().addPrimitive(prim);
}
function toFrame(fr, x, y, z) {
  if (!fr.rake) return [x, y, z];
  const c = Math.cos(fr.rake), s = Math.sin(fr.rake);
  return [x, y * c + z * s, -y * s + z * c];   // rotate by -rake about x
}
function listTextured(m) {
  return !!(m.getBaseColorTexture() || m.getNormalTexture() || m.getMetallicRoughnessTexture() || m.getEmissiveTexture() || m.getOcclusionTexture());
}

// Drop the source scene, then everything only it used.
for (const sc of root.listScenes()) if (sc !== scene) sc.dispose();
for (const node of root.listNodes()) if (![...nodes.values()].includes(node)) node.dispose();
root.setDefaultScene(scene);
for (const m of root.listMaterials()) {
  // the texture coordinates are all TEXCOORD_0 now
  for (const slot of ['BaseColor', 'Normal', 'MetallicRoughness', 'Occlusion', 'Emissive']) m[`get${slot}TextureInfo`]()?.setTexCoord(0);
}
await doc.transform(prune());

// --- 6. Simplify each part, then merge each part's primitives per material. ---------------------------------------
for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) {
  weldPrimitive(prim);
  const detail = prim.getExtras().detail, [error, ratio] = car.detail?.[detail] ?? DETAIL[detail];
  const before = triCount([prim]);
  simplify(prim, ratio, error);
  if (process.env.VERBOSE) console.log(`  ${mesh.getName()} ${prim.getMaterial()?.getName()} ${detail}: ${before} -> ${triCount([prim])}`);
  prim.setExtras({});
}
await doc.transform(join({ keepNamed: true }));

// meshoptimizer's simplifier, also dropping small loose pieces (bolts, clips) that fall under the error limit, which
// would otherwise stop it short of the target.
function simplify(prim, ratio, error) {
  const pos = prim.getAttribute('POSITION').getArray(), idx = prim.getIndices();
  const indices = new Uint32Array(idx.getArray());
  const target = Math.floor((indices.length / 3) * ratio) * 3;
  const [out] = MeshoptSimplifier.simplify(indices, pos instanceof Float32Array ? pos : new Float32Array(pos), 3, target, error, ['Prune']);
  idx.setArray(out.length === indices.length ? indices : out.slice());
  compactPrimitive(prim);
}

// --- 7. Textures: WebP, the livery at up to 2048 px and the rest at up to 512-1024. ------------------------------
for (const ext of [KHRMaterialsClearcoat, KHRMaterialsSpecular, KHRMaterialsTransmission, KHRMaterialsEmissiveStrength]) {
  root.listExtensionsUsed().find((e) => e.extensionName === ext.EXTENSION_NAME)?.dispose();
}
root.listTextures().forEach((t, i) => { if (!t.getName()) t.setName(`t${i}`); });
doc.createExtension(EXTTextureWebP).setRequired(true);
await doc.transform(
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [2048, 2048], quality: 82, pattern: /^livery$/ }),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 80, slots: /baseColor|emissive/, pattern: /^t/ }),   // (a pattern is tried on the URI too, and these have none)
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512], quality: 85, slots: /normal|metallicRoughness|occlusion/ }),
  dedup(), prune(),
);

// --- 8. Compress the geometry and write. --------------------------------------------------------------------------
doc.createExtension(EXTMeshoptCompression).setRequired(true);
await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
const outDir = pathJoin(ROOT, 'public/cars', id), out = pathJoin(outDir, 'model.glb');
mkdirSync(outDir, { recursive: true });
await io.write(out, doc);

const tris = triCount(root.listMeshes().flatMap((m) => m.listPrimitives()));
const fmt = (v) => v.map((x) => x.toFixed(3)).join(', ');
console.log(`${id}: ${srcTris} -> ${tris} triangles, ${root.listMaterials().length} materials, ${root.listTextures().length} textures, ${(statSync(out).size / 1e6).toFixed(2)} MB -> ${out}`);
console.log(`  scale ${scale.toFixed(4)}; hubs ${hubsG.map((h) => `[${fmt(h)}]`).join(' ')}`);
console.log(`  tyre radius ${fmt(radii.map((r) => r * scale))} (spec ${tg.wheelRadius}); steering wheel at [${fmt(steerCentre)}], rake ${((rake * 180) / Math.PI).toFixed(1)} deg, grip ${grip.toFixed(3)}`);
for (const node of root.listNodes()) console.log(`  ${node.getName()}: ${triCount(node.getMesh().listPrimitives())} triangles, ${node.getMesh().listPrimitives().length} primitives`);

// Jacobi eigen-decomposition of a symmetric 3x3 matrix; returns the eigenvector of its smallest or largest eigenvalue.
function eigenvector(A, which) {
  const a = A.map((r) => r.slice()), v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-15) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
    }
  }
  const i = [0, 1, 2].reduce((m, k) => ((which === 'largest' ? a[k][k] > a[m][m] : a[k][k] < a[m][m]) ? k : m), 0);
  return [v[0][i], v[1][i], v[2][i]];
}
