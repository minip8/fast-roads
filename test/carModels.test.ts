// The GT3s' model files (public/cars/<id>/model.glb) and how a car swaps its model in. The files are checked
// against the specs they ride on; the swap runs with a stand-in model, since Node has no loader for the real ones.
import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { type CarMesh, type CarModelDef, GT3_MODEL, LC_GT3_MODEL, setCarModelSource } from '../src/carMeshes';
import { CARS, type CarId } from '../src/cars';

const MODELS: [CarId, CarModelDef][] = [['gt3', GT3_MODEL], ['lcgt3', LC_GT3_MODEL]];
const PARTS = ['body', 'steering_wheel', 'brake_light', ...['FL', 'FR', 'RL', 'RR'].flatMap((c) => [`wheel_${c}`, `hub_${c}`])];

// The JSON chunk of a .glb (no need to decode the geometry for where the parts are).
function glbJson(file: string) {
  const b = readFileSync(file);
  expect(b.toString('ascii', 0, 4)).toBe('glTF');
  const len = b.readUInt32LE(12);
  return JSON.parse(b.toString('utf8', 20, 20 + len)) as {
    nodes: { name: string; mesh?: number; extras?: Record<string, unknown> }[];
    meshes: { primitives: { material?: number }[] }[]; materials: { name: string }[];
  };
}

describe.each(MODELS)('%s model file', (id, def) => {
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

  // The Red Bull model keeps the wheel's button labels in its interior stickers mesh: they must turn with the wheel.
  it.runIf(id === 'lcgt3')('turns the labels with the steering wheel', () => {
    const json = glbJson(file), node = json.nodes.find((n) => n.name === 'steering_wheel')!;
    const mats = json.meshes[node.mesh!].primitives.map((p) => json.materials[p.material!].name);
    expect(mats).toContain('MI_Mercedes_AMG_GT3_Evo_Interior_Stickers');
  });

  it('is small, and carries its licence and credits', () => {
    expect(readFileSync(file).length).toBeLessThan(4.5e6);
    const licence = file.replace(/model\.glb$/, 'LICENSE.md');
    expect(existsSync(licence)).toBe(true);
    expect(readFileSync(licence, 'utf8')).toMatch(/CC BY-NC-SA 4\.0/);
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
    const spec = CARS.gt3, mesh = spec.mesh(spec);
    const oldGeo = disposed(procedural(mesh).geometry), oldCockpit = mesh.cockpit, oldLight = mesh.brakeLight;
    await settle();
    expect(oldGeo.hit).toBe(true);                                         // the built body is freed
    expect(mesh.cockpit).not.toBe(oldCockpit);
    expect(mesh.cockpit.wheel.getObjectByName('steering_wheel')).toBeDefined();
    expect(mesh.cockpit.mount.position.toArray()).toEqual([0.4, 0.33, -0.14]);
    expect(mesh.cockpit.arms[0].r).toBe(0.12);
    expect(mesh.brakeLight).not.toBe(oldLight);
    expect(mesh.brakeLight.material).not.toBe(m.mat);                     // its own, so lighting it lights only this car
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
