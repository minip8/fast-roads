// The car model files (public/cars/<id>/model.glb) and how a car swaps its model in. The files are checked
// against the specs they ride on; the swap runs with a stand-in model, since Node has no loader for the real ones.
import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { type CarMesh, type CarModelDef, LC_F1_MODEL, LC_GT3_MODEL, poseFlaps, setCarModelSource } from '../src/carMeshes';
import { CARS, type CarId } from '../src/cars';

// Per model: its licence, the materials that must turn with the steering wheel (besides its own) and its flaps.
interface Expect { licence: RegExp; onWheel: string[]; flaps: string[] }
const MODELS: [CarId, CarModelDef, Expect][] = [
  // The Red Bull model keeps the wheel's button labels in its interior stickers mesh: they must turn with the wheel.
  ['lcgt3', LC_GT3_MODEL, { licence: /CC BY-NC-SA 4\.0/, onWheel: ['MI_Mercedes_AMG_GT3_Evo_Interior_Stickers'], flaps: [] }],
  // The F1's display and rev lights are on its steering wheel.
  ['lcf1', LC_F1_MODEL, { licence: /CC BY 4\.0/, onWheel: ['INT_DISPLAY', 'vehicle_revs_type1'],
    flaps: ['flap_R1', 'flap_R2', 'flap_FL1', 'flap_FL2', 'flap_FR1', 'flap_FR2'] }],
];
const PARTS = ['body', 'steering_wheel', 'brake_light', ...['FL', 'FR', 'RL', 'RR'].flatMap((c) => [`wheel_${c}`, `hub_${c}`])];

type GlbNode = { name: string; mesh?: number; extras?: Record<string, unknown>; translation?: number[]; rotation?: number[]; scale?: number[] };
type Glb = {
  nodes: GlbNode[];
  meshes: { primitives: { material?: number; attributes: Record<string, number> }[] }[]; materials: { name: string }[];
  accessors: { min?: number[]; max?: number[]; componentType: number; normalized?: boolean }[];
};
// The JSON chunk of a .glb (no need to decode the geometry for where the parts are).
function glbJson(file: string) {
  const b = readFileSync(file);
  expect(b.toString('ascii', 0, 4)).toBe('glTF');
  const len = b.readUInt32LE(12);
  return JSON.parse(b.toString('utf8', 20, 20 + len)) as Glb;
}
// One material's part of a node, its bounds ([min, max] per axis) in the node's own frame (extras.frame: its origin
// and rake), from its accessor's bounds (quantized positions: normalized int16, the node's transform gives metres).
function partBounds(json: Glb, node: GlbNode, material: string) {
  const prim = json.meshes[node.mesh!].primitives.find((p) => json.materials[p.material!].name === material)!;
  const a = json.accessors[prim.attributes.POSITION], q = a.componentType === 5122 && a.normalized ? 32767 : 1;
  const fr = node.extras!.frame as { origin: number[]; rake: number };
  const m = new THREE.Matrix4().compose(new THREE.Vector3().fromArray(node.translation ?? [0, 0, 0]),
    new THREE.Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]), new THREE.Vector3().fromArray(node.scale ?? [1, 1, 1]));
  const frame = new THREE.Matrix4().compose(new THREE.Vector3().fromArray(fr.origin),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), fr.rake), new THREE.Vector3(1, 1, 1));
  const box = new THREE.Box3(new THREE.Vector3().fromArray(a.min!).divideScalar(q), new THREE.Vector3().fromArray(a.max!).divideScalar(q));
  box.applyMatrix4(frame.invert().multiply(m));
  return [0, 1, 2].map((k) => [box.min.getComponent(k), box.max.getComponent(k)]);
}

describe.each(MODELS)('%s model file', (id, def, ex) => {
  const spec = CARS[id], file = `public/${def.url}`;
  it('has every part, its wheels on the spec\'s axles and its tyres on the road', () => {
    const nodes = glbJson(file).nodes, byName = new Map(nodes.map((n) => [n.name, n]));
    for (const p of PARTS) expect(byName.has(p), p).toBe(true);
    ['FL', 'FR', 'RL', 'RR'].forEach((c, k) => {
      const ex = byName.get(`wheel_${c}`)!.extras as { frame: { origin: number[] }; radius: number };
      const [x, y, z] = ex.frame.origin;
      expect(z).toBeCloseTo(k < 2 ? spec.zFront : spec.zRear, 2);
      expect(Math.abs(x - (k % 2 ? -spec.trackHalf : spec.trackHalf))).toBeLessThan(0.05);   // the model's own track
      expect(Math.abs(ex.radius - spec.wheelRadius)).toBeLessThan(0.02);
      expect(Math.abs(y - ex.radius + spec.comHeight)).toBeLessThan(0.01);                      // bottom of the tyre on the road
    });
    const grip = byName.get('steering_wheel')!.extras!.grip as number;
    expect(grip).toBeGreaterThan(0.08); expect(grip).toBeLessThan(0.2);
  });

  it('turns its screen, lights and labels with the steering wheel', () => {
    const json = glbJson(file), node = json.nodes.find((n) => n.name === 'steering_wheel')!;
    const mats = json.meshes[node.mesh!].primitives.map((p) => json.materials[p.material!].name);
    for (const m of ex.onWheel) expect(mats).toContain(m);
  });

  // The live display covers the model's own screen and shift lights, which each car hides in its copy: on the dash
  // (body coordinates) or on the steering wheel (its own frame).
  it('puts the live display over the model\'s screen and shift lights', () => {
    const json = glbJson(file), sc = def.screen!;
    const node = json.nodes.find((n) => n.name === (sc.on === 'wheel' ? 'steering_wheel' : 'body'))!;
    for (const [name, quad] of [[sc.hide[0], sc.display], [sc.hide[1], sc.leds!]] as const) {
      const [x, y, z] = partBounds(json, node, name);
      expect(Math.abs(quad.x - (x[0] + x[1]) / 2), name).toBeLessThan(0.003);
      expect(Math.abs(quad.y - (y[0] + y[1]) / 2), name).toBeLessThan(0.003);
      expect(Math.abs(quad.w - (x[1] - x[0])), name).toBeLessThan(0.004);
      expect(Math.abs(quad.h * Math.cos(quad.tilt ?? 0) - (y[1] - y[0])), name).toBeLessThan(0.004);
      expect(quad.z, name).toBeLessThan((z[0] + z[1]) / 2);                 // in front of it, seen from the seat...
      expect(quad.z, name).toBeGreaterThan(z[0] - 0.004);                   // ...and close
    }
  });

  it('has its flaps, each turning about its hinge to open', () => {
    const json = glbJson(file), flaps = json.nodes.filter((n) => n.name.startsWith('flap_'));
    expect(flaps.map((n) => n.name).sort()).toEqual([...ex.flaps].sort());
    const byName = new Map(flaps.map((n) => [n.name, n]));
    for (const n of flaps) {
      const e = n.extras as { frame: { origin: number[] }; open: number[] };
      const q = new THREE.Quaternion().fromArray(e.open), half = Math.acos(Math.min(1, Math.abs(q.w))), deg = (2 * half * 180) / Math.PI;
      expect(Math.hypot(...e.open), n.name).toBeCloseTo(1, 6);
      expect(deg, n.name).toBeGreaterThan(5); expect(deg, n.name).toBeLessThan(25);   // a flap's travel...
      expect(Math.abs(q.x) / Math.sin(half), n.name).toBeGreaterThan(0.9);            // ...mostly about x, across the car
      // the hinge is on the flap: inside its bounds, give or take a few centimetres
      for (const [lo, hi] of partBounds(json, n, json.materials[json.meshes[n.mesh!].primitives[0].material!].name)) {
        expect(lo, n.name).toBeLessThan(0.03); expect(hi, n.name).toBeGreaterThan(-0.03);
      }
      // the rear wing's behind the rear axle, the front wing's ahead of the front one; left and right mirrored
      const [ox, , oz] = e.frame.origin;
      if (n.name.startsWith('flap_R')) expect(oz).toBeLessThan(CARS[id].zRear);
      else expect(oz).toBeGreaterThan(CARS[id].zFront);
      const twin = byName.get(n.name.replace(/F([LR])/, (_, s: string) => `F${s === 'L' ? 'R' : 'L'}`))!;
      const t = twin.extras as { frame: { origin: number[] }; open: number[] };
      expect(t.frame.origin[0], n.name).toBeCloseTo(n.name.startsWith('flap_R') ? ox : -ox, 2);
      expect(t.open[0], n.name).toBeCloseTo(e.open[0], 4);
      if (!n.name.startsWith('flap_R')) expect(t.open[1], n.name).toBeCloseTo(-e.open[1], 4);
    }
  });

  it('is small, and carries its licence and credits', () => {
    expect(readFileSync(file).length).toBeLessThan(4.5e6);
    const licence = file.replace(/model\.glb$/, 'LICENSE.md');
    expect(existsSync(licence)).toBe(true);
    expect(readFileSync(licence, 'utf8')).toMatch(ex.licence);
  });
});

// A stand-in for a loaded model: the parts the converter writes, each a box, with the extras the game reads.
function standIn() {
  const scene = new THREE.Group(), geo = new THREE.BoxGeometry(0.1, 0.1, 0.1), mat = new THREE.MeshStandardMaterial();
  const add = (name: string, origin: number[], extras: Record<string, unknown> = {}) => {
    const m = new THREE.Mesh(geo, mat);
    m.name = name; m.position.set(origin[0], origin[1], origin[2]);
    m.userData = { frame: { origin, rake: 0 }, ...extras };
    scene.add(m);
  };
  add('body', [0, 0, 0]);
  add('brake_light', [0, 0, 0]);
  add('steering_wheel', [0.4, 0.33, -0.14], { grip: 0.12 });
  [[0.84, 1.378], [-0.84, 1.378], [0.84, -1.272], [-0.84, -1.272]].forEach(([x, z], k) => {
    const c = ['FL', 'FR', 'RL', 'RR'][k];
    add(`wheel_${c}`, [x, -0.06, z], { radius: 0.34 }); add(`hub_${c}`, [x, -0.06, z]);
  });
  add('flap_R1', [0, 0.52, -1.95], { open: [-0.1392, 0, 0, 0.9903] });   // 16 deg about x
  return { scene, geo, mat };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const disposed = (o: { addEventListener(t: 'dispose', f: () => void): void }) => { const s = { hit: false }; o.addEventListener('dispose', () => { s.hit = true; }); return s; };
const procedural = (mesh: CarMesh) => (mesh.root.children.find((c) => !mesh.wheels.some((w) => w.pivot === c))!.children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh);

describe('model swap', () => {
  afterEach(() => setCarModelSource(null));

  it('replaces the built body, wheels and steering wheel, and leaves the shared model alone on dispose', async () => {
    const m = standIn();
    setCarModelSource(async () => m.scene);
    const spec = CARS.lcgt3, mesh = spec.mesh(spec);
    const oldGeo = disposed(procedural(mesh).geometry), oldCockpit = mesh.cockpit, oldLight = mesh.brakeLight;
    await settle();
    expect(oldGeo.hit).toBe(true);                                         // the built body is freed
    expect(mesh.cockpit).not.toBe(oldCockpit);
    expect(mesh.cockpit.wheel.getObjectByName('steering_wheel')).toBeDefined();
    expect(mesh.cockpit.mount.position.toArray()).toEqual([0.4, 0.33, -0.14]);
    expect(mesh.cockpit.arms[0].r).toBe(0.12);
    expect(mesh.brakeLight).not.toBe(oldLight);
    expect(mesh.brakeLight.material).not.toBe(m.mat);                     // its own, so lighting it lights only this car
    expect(mesh.cockpit.screen?.mesh.parent?.parent).toBe(mesh.root);      // the model's display, on its dash
    mesh.wheels.forEach((w, k) => {
      const c = ['FL', 'FR', 'RL', 'RR'][k];
      expect(w.spinner.children.map((o) => o.name)).toEqual([`wheel_${c}`]);
      expect(w.spinner.children[0].position.length()).toBeLessThan(1e-9);  // the hub is the spinner's origin...
      expect(w.spinner.position.x).toBeCloseTo((k % 2 ? 1 : -1) * (spec.trackHalf - 0.84), 9);   // ...at the model's track
      expect(w.spinner.position.y).toBeCloseTo(0.34 - spec.wheelRadius, 9);   // and tyre size
      expect(w.pivot.getObjectByName(`hub_${c}`)).toBeDefined();
    });
    const shared = disposed(m.geo), sharedMat = disposed(m.mat), light = disposed(mesh.brakeLight.material);
    mesh.dispose();
    expect(shared.hit).toBe(false); expect(sharedMat.hit).toBe(false);
    expect(light.hit).toBe(true);
  });

  it('hangs the flaps on their hinges and puts a screen on the steering wheel', async () => {
    const m = standIn();
    setCarModelSource(async () => m.scene);
    const spec = CARS.lcf1, mesh = spec.mesh(spec);
    expect(mesh.flaps).toEqual([]);                                        // the built body has none
    await settle();
    expect(mesh.flaps.length).toBe(1);
    const f = mesh.flaps[0], open = f.open.angleTo(new THREE.Quaternion());
    expect(f.pivot.position.toArray()).toEqual([0, 0.52, -1.95]);          // at the hinge...
    expect(f.pivot.getObjectByName('flap_R1')!.position.length()).toBeLessThan(1e-9);   // ...which is the part's origin
    expect(open).toBeCloseTo((16 * Math.PI) / 180, 2);
    for (const [pos, share] of [[0, 0], [0.5, 0.5], [1, 1], [0.25, 0.15625]]) {   // eased in and out (smoothstep)
      poseFlaps(mesh, pos);
      expect(f.pivot.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(open * share, 6);
    }
    expect(mesh.cockpit.screen?.mesh.parent).toBe(mesh.cockpit.wheel);    // turns with the wheel
    mesh.dispose();
  });

  it('keeps the built body when the car is gone before the model arrives, or the model fails to load', async () => {
    let arrive!: (o: THREE.Object3D) => void;
    setCarModelSource(() => new Promise((r) => { arrive = r; }));
    const spec = CARS.lcgt3, early = spec.mesh(spec), cockpit = early.cockpit;
    early.dispose();
    arrive(standIn().scene);
    await settle();
    expect(early.cockpit).toBe(cockpit);

    const warn = console.warn;
    console.warn = () => {};
    try {
      setCarModelSource(() => Promise.reject(new Error('offline')));
      const failed = spec.mesh(spec), built = failed.cockpit;
      await settle();
      expect(failed.cockpit).toBe(built);
      expect(failed.wheels[0].spinner.children.length).toBeGreaterThan(1);   // the built tyre and rim
    } finally { console.warn = warn; }
  });
});
