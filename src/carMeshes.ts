import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Batch } from './batch';
import type { CarInfo } from './cars';

// Car bodies. Built in Node too (the tests construct cars), so nothing here may touch the DOM.
export interface CarMesh {
  root: THREE.Group;                 // follows the physics body
  wheels: { pivot: THREE.Group; spinner: THREE.Group }[];   // pivot: steer + suspension; spinner: rolling
  brakeLight: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  cockpit: Cockpit;
}

// The driver and what they see from the seat. Positions are in body coordinates (the root's frame).
export interface Cockpit {
  eye: THREE.Vector3;                // the driver camera
  look: number;                      // how far the driver camera looks down over 10 m (m)
  head: THREE.Group;                 // helmet: hidden while the camera is inside it
  mount: THREE.Group;                // steering column (position and rake)
  wheel: THREE.Group;                // steering wheel, turned by poseCockpit
  ratio: number;                     // steering-wheel angle per road-wheel angle
  arms: { mesh: THREE.Mesh; glove: THREE.Mesh; shoulder: THREE.Vector3; side: number; r: number }[];
}

// Reflections for paint and metal (a blurred sky, set by the stage before any car is built). Without one, metallic
// materials render nearly black.
let envMap: THREE.Texture | null = null;
export function setCarEnvironment(tex: THREE.Texture | null) { envMap = tex; }
const mat = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ envMap, envMapIntensity: 0.7, ...p });

// Static body parts go into one merged mesh per material (a car is a handful of draw calls, not forty).
function parts(group: THREE.Group) {
  const batch = new Batch(), m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const p = new THREE.Vector3(), s = new THREE.Vector3();
  const add = (geo: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
    batch.add(geo, m.compose(p.set(x, y, z), q.setFromEuler(e.set(rx, ry, rz)), s.set(sx, sy, sz)), material);
  const done = () => { for (const mesh of batch.build(group, { castShadow: true, receiveShadow: false })) mesh.name = 'body'; };
  return { add, done };
}

// Box whose cross-section scales linearly along z: (sx, sy) at the back (-z) and front (+z) ends. Heights scale
// from the bottom face, so a tapered top slopes down while the floor stays flat.
function taper(w: number, h: number, l: number, back: [number, number], front: [number, number]) {
  const g = new THREE.BoxGeometry(w, h, l), pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getZ(i) + l / 2) / l, sx = back[0] + (front[0] - back[0]) * t, sy = back[1] + (front[1] - back[1]) * t;
    pos.setXY(i, pos.getX(i) * sx, -h / 2 + (pos.getY(i) + h / 2) * sy);
  }
  g.computeVertexNormals();
  return g;
}
const B = (w: number, h: number, l: number) => new THREE.BoxGeometry(w, h, l);
type Add = ReturnType<typeof parts>['add'];

interface DriverOpts {
  x: number; head: [y: number, z: number];   // helmet centre
  helmet: number; suit: number;
  shoulder: [dy: number, dz: number];          // shoulders relative to the helmet centre
  wheel: { y: number; z: number; rake: number; r: number; f1?: boolean };
  ratio: number; look: number;
}

// Seated driver (helmet, torso, arms) and steering wheel. The torso goes into the car's merged body; the helmet,
// wheel and arms are separate meshes because they hide or move.
function addDriver(group: THREE.Group, add: Add, o: DriverOpts): Cockpit {
  const [hy, hz] = o.head;
  const suit = mat({ color: o.suit, roughness: 0.7, envMapIntensity: 0.3 });
  const dark = mat({ color: 0x111214, roughness: 0.55, metalness: 0.2, envMapIntensity: 0.3 });
  const glove = mat({ color: 0x1d1f24, roughness: 0.8, envMapIntensity: 0.2 });
  add(B(0.4, 0.5, 0.26), suit, o.x, hy - 0.38, hz - 0.06);                            // torso
  add(B(0.5, 0.75, 0.08), dark, o.x, hy - 0.3, hz - 0.24);                           // seat back

  const head = new THREE.Group();
  head.position.set(o.x, hy, hz);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.135, 16, 12), mat({ color: o.helmet, roughness: 0.2, metalness: 0.2 }));
  const visor = new THREE.Mesh(B(0.2, 0.05, 0.08), mat({ color: 0x16181c, roughness: 0.1, metalness: 0.6, envMapIntensity: 1 }));
  visor.position.set(0, 0.02, 0.1);
  helmet.castShadow = visor.castShadow = true;
  head.add(helmet, visor);
  group.add(head);

  const w = o.wheel, mount = new THREE.Group(), wheel = new THREE.Group();
  mount.position.set(o.x, w.y, w.z); mount.rotation.x = w.rake;   // top of the wheel leans away from the driver
  mount.add(wheel); group.add(mount);
  const wheelParts: [THREE.BufferGeometry, THREE.Material][] = [];
  const display = new THREE.MeshStandardMaterial({ color: 0x0a0c10, emissive: 0x3fd0ff, emissiveIntensity: 0.25 });
  const marker = mat({ color: 0xffd23f, roughness: 0.5 });
  const grip = w.r;
  if (w.f1) {   // F1: a carbon body with two grips and a screen
    wheelParts.push([B(w.r * 1.6, 0.1, 0.04), dark], [B(0.08, 0.04, 0.005).translate(0, 0.01, -0.021), display],
      [new THREE.CylinderGeometry(0.028, 0.028, 0.14, 10).translate(-w.r, 0, 0), dark],
      [new THREE.CylinderGeometry(0.028, 0.028, 0.14, 10).translate(w.r, 0, 0), dark],
      [B(0.06, 0.012, 0.045).translate(0, 0.05, 0), marker]);
  } else {      // round rim, three spokes, a marker at the top so you can see it turn
    wheelParts.push([new THREE.TorusGeometry(w.r, 0.019, 8, 32), dark],
      [new THREE.CylinderGeometry(0.05, 0.05, 0.05, 14).rotateX(Math.PI / 2), dark],
      [B(w.r * 2, 0.035, 0.015), dark], [B(0.035, w.r, 0.015).translate(0, -w.r / 2, 0), dark],
      [B(0.03, 0.04, 0.04).translate(0, w.r, 0), marker]);
  }
  for (const [g, m] of wheelParts) { const mesh = new THREE.Mesh(g, m); mesh.castShadow = true; wheel.add(mesh); }
  const arms: Cockpit['arms'] = [];
  const armGeo = new THREE.CylinderGeometry(0.034, 0.042, 1, 8);
  for (const s of [-1, 1]) {
    const g = new THREE.Mesh(new THREE.SphereGeometry(0.042, 10, 8), glove);
    g.scale.set(1, 1.3, 1); mount.add(g);
    const mesh = new THREE.Mesh(armGeo, suit); mesh.castShadow = true; group.add(mesh);
    arms.push({ mesh, glove: g, shoulder: new THREE.Vector3(o.x + s * 0.17, hy + o.shoulder[0], hz + o.shoulder[1]), side: s, r: grip });
  }
  const cockpit: Cockpit = { eye: new THREE.Vector3(o.x, hy + 0.02, hz + 0.06), look: o.look, head, mount, wheel, ratio: o.ratio, arms };
  poseCockpit(cockpit, 0);
  return cockpit;
}

// Turn the steering wheel to the road wheels' angle (rad, + = left) and reach the arms to it. The hands turn with
// the rim up to HAND_MAX and then slide round it, so at full lock the arms don't cross in front of the wheel.
const HAND_MAX = 1.0;
const _hand = new THREE.Vector3(), _dir = new THREE.Vector3(), _Y = new THREE.Vector3(0, 1, 0);
export function poseCockpit(c: Cockpit, steer: number) {
  const a = -steer * c.ratio;   // seen from the seat, turning left is anticlockwise
  c.wheel.rotation.z = a;
  const h = Math.max(-HAND_MAX, Math.min(HAND_MAX, a));
  for (const arm of c.arms) {
    arm.glove.position.set(arm.side * arm.r * Math.cos(h), arm.side * arm.r * Math.sin(h), -0.01);
    arm.glove.rotation.z = h;
    _hand.set(arm.glove.position.x, arm.glove.position.y, -0.03).applyQuaternion(c.mount.quaternion).add(c.mount.position);
    const d = _dir.subVectors(_hand, arm.shoulder), len = d.length();
    arm.mesh.position.copy(arm.shoulder).addScaledVector(d, 0.5);
    arm.mesh.quaternion.setFromUnitVectors(_Y, d.divideScalar(len));
    arm.mesh.scale.set(1, len, 1);
  }
}

// Body colour, accent colour and wheel stripe, so one body can carry more than one livery.
export interface Paint { body: number; accent: number; stripe: number }

export function buildCarMesh(spec: CarInfo, paint: Paint = { body: 0xff6a13, accent: 0x1fa6ff, stripe: 0xffd23f }): CarMesh {
  const root = new THREE.Group(), bodyGroup = new THREE.Group();
  root.add(bodyGroup);
  const body = mat({ color: paint.body, roughness: 0.3, metalness: 0.25 });
  const dark = mat({ color: 0x16181c, roughness: 0.5, metalness: 0.3, envMapIntensity: 0.35 });
  const carbon = mat({ color: 0x24272c, roughness: 0.35, metalness: 0.5, envMapIntensity: 0.35 });
  const accent = mat({ color: paint.accent, roughness: 0.35, metalness: 0.3 });
  const { add, done } = parts(bodyGroup);
  add(B(1.35, 0.04, 3.4), carbon, 0, -0.2, -0.05);                                   // floor
  add(taper(0.66, 0.42, 2.2, [1, 1], [0.7, 1]), body, 0, 0.0, 0.25);                   // tub, narrowing to the nose
  add(taper(0.36, 0.2, 1.6, [1, 1], [0.45, 0.55]), body, 0, -0.06, 1.95, 0.07);        // nose
  add(taper(0.16, 0.11, 0.4, [1, 1], [0.6, 0.6]), accent, 0, -0.14, 2.82, 0.07);       // nose tip
  add(B(1.9, 0.03, 0.5), carbon, 0, -0.23, 2.75);                                     // front wing
  add(B(1.7, 0.03, 0.25), accent, 0, -0.16, 2.6, -0.25);                              // flap
  for (const s of [-1, 1]) add(B(0.03, 0.22, 0.6), carbon, s * 0.95, -0.15, 2.75);    // endplates
  for (const s of [-1, 1]) add(taper(0.48, 0.34, 1.5, [0.6, 0.55], [1, 1]), body, s * 0.55, -0.04, -0.1);   // sidepods, waisted at the back
  for (const s of [-1, 1]) add(B(0.06, 0.3, 0.08), dark, s * 0.8, -0.04, 0.68);       // bargeboards
  for (const s of [-1, 1]) {                                                           // mirrors
    add(B(0.02, 0.22, 0.02), carbon, s * 0.44, 0.24, 0.72);
    add(B(0.1, 0.045, 0.04), carbon, s * 0.47, 0.35, 0.72);
  }
  add(taper(0.48, 0.42, 1.5, [0.45, 0.5], [1, 1]), body, 0, 0.22, -0.9, -0.08);         // engine cover, tapering to the gearbox
  add(B(0.24, 0.28, 0.55), dark, 0, 0.52, -0.25);                                     // airbox
  add(taper(0.12, 0.35, 1.0, [1, 1], [1, 0.25]), body, 0, 0.5, -0.9, -0.15);           // shark fin
  add(B(0.44, 0.012, 0.75), dark, 0, 0.212, 0.35);                                    // cockpit opening
  const cockpit = addDriver(bodyGroup, add, { x: 0, head: [0.36, 0.1], helmet: 0xf5f5f5, suit: paint.body, shoulder: [-0.15, 0],
    wheel: { y: 0.235, z: 0.47, rake: 0.3, r: 0.13, f1: true }, ratio: 4, look: 0.3 });
  add(new THREE.TorusGeometry(0.28, 0.025, 6, 20, Math.PI), carbon, 0, 0.42, 0.25, Math.PI / 2, 0, Math.PI, 1, 1.3, 1);   // halo
  add(B(0.05, 0.2, 0.05), carbon, 0, 0.33, 0.62, 0.3);                                // halo strut
  add(B(1.0, 0.05, 0.36), carbon, 0, 0.6, -2.05, 0.12);                               // rear wing main
  add(B(1.0, 0.04, 0.22), accent, 0, 0.72, -2.15, 0.35);                              // rear flap
  for (const s of [-1, 1]) add(B(0.03, 0.55, 0.6), carbon, s * 0.5, 0.42, -2.05);
  add(B(0.06, 0.45, 0.25), carbon, 0, 0.32, -1.95);                                   // pylon
  add(B(0.9, 0.18, 0.5), carbon, 0, -0.18, -1.9);                                     // diffuser
  // suspension arms
  for (const [x, z] of [[1, spec.zFront], [-1, spec.zFront], [1, spec.zRear], [-1, spec.zRear]]) {
    add(B(0.62, 0.025, 0.06), dark, x * 0.5, 0.06, z, 0, 0, -x * 0.12);
    add(B(0.62, 0.025, 0.06), dark, x * 0.5, -0.05, z + 0.08, 0, 0, x * 0.05);
  }
  done();
  const brakeLight = new THREE.Mesh(B(0.12, 0.08, 0.03), new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1010, emissiveIntensity: 0.4 }));
  brakeLight.position.set(0, 0.05, -2.32); bodyGroup.add(brakeLight);
  const wheels = buildWheels(root, spec, { rim: 0x2a2d33, stripe: paint.stripe });
  return { root, wheels, brakeLight, cockpit };
}

// Four wheels (pivot for steer/suspension, spinner for rolling) shared by every car body. The tyre has rounded
// shoulders and the rim has spokes, so you can see the wheels turn.
function buildWheels(root: THREE.Group, spec: CarInfo, colors: { rim: number; stripe?: number }): CarMesh['wheels'] {
  const tyreMat = mat({ color: 0x1c1c1e, roughness: 0.82, envMapIntensity: 0.3 });
  const rimMat = mat({ color: colors.rim, roughness: 0.35, metalness: 0.6 });
  const stripeMat = colors.stripe === undefined ? null : mat({ color: colors.stripe, roughness: 0.6 });
  const r = spec.wheelRadius, geos = new Map<number, { tyre: THREE.BufferGeometry; rim: THREE.BufferGeometry }>();
  const wheelGeo = (w: number, side: number) => {
    const key = w * side;
    let g = geos.get(key);
    if (g) return g;
    const h = w / 2, P = (x: number, y: number) => new THREE.Vector2(x, y);
    const tyre = new THREE.LatheGeometry([P(r * 0.66, -h), P(r * 0.93, -h), P(r * 0.985, -h + 0.02), P(r, -h + 0.05),
      P(r, h - 0.05), P(r * 0.985, h - 0.02), P(r * 0.93, h), P(r * 0.66, h)], 32).rotateZ(Math.PI / 2);
    const rimParts: THREE.BufferGeometry[] = [new THREE.CylinderGeometry(r * 0.66, r * 0.66, w - 0.05, 24).rotateZ(Math.PI / 2)];
    const face = side * (h - 0.02);
    for (let k = 0; k < 5; k++) rimParts.push(new THREE.BoxGeometry(0.04, r * 0.56, 0.075).translate(face, r * 0.3, 0).rotateX((k * 2 * Math.PI) / 5));
    rimParts.push(new THREE.CylinderGeometry(r * 0.12, r * 0.12, 0.05, 12).rotateZ(Math.PI / 2).translate(face, 0, 0));   // hub
    for (const p of rimParts) p.deleteAttribute('uv');
    g = { tyre, rim: mergeGeometries(rimParts.map((p) => (p.index ? p.toNonIndexed() : p))) };
    geos.set(key, g);
    return g;
  };
  const wheels: CarMesh['wheels'] = [];
  for (const [x, front] of [[spec.trackHalf, 1], [-spec.trackHalf, 1], [spec.trackHalf, 0], [-spec.trackHalf, 0]]) {
    const pivot = new THREE.Group(), spinner = new THREE.Group();
    const w = spec.tyreW[front ? 0 : 1], side = Math.sign(x);
    const g = wheelGeo(w, side);
    const tyre = new THREE.Mesh(g.tyre, tyreMat); tyre.castShadow = true;
    spinner.add(tyre, new THREE.Mesh(g.rim, rimMat));
    if (stripeMat) {
      const stripe = new THREE.Mesh(new THREE.TorusGeometry(r * 0.82, 0.012, 4, 28), stripeMat);
      stripe.rotation.y = Math.PI / 2; stripe.position.x = side * (w / 2 + 0.002);
      spinner.add(stripe);
    }
    pivot.add(spinner); root.add(pivot);
    wheels.push({ pivot, spinner });
  }
  return wheels;
}

// Side profile (z forward, y up) for `extrude`, with arches cut into the floor line at the given axles.
function profile(pts: [number, number][], arches: number[], arch: { y: number; r: number; bottom: number }) {
  const sh = new THREE.Shape();
  sh.moveTo(pts[0][0], pts[0][1]);
  for (let k = 1; k < pts.length; k++) {
    sh.lineTo(pts[k][0], pts[k][1]);
    if (k === 1) {   // along the floor, rear to front
      const a = Math.asin((arch.bottom - arch.y) / arch.r), dx = Math.cos(a) * arch.r;
      for (const z of arches) { sh.lineTo(z - dx, arch.bottom); sh.absarc(z, arch.y, arch.r, Math.PI - a, a, true); }
    }
  }
  return sh;
}
// A side profile extruded across the car to `width`, centred, with bevelled edges.
function extrude(sh: THREE.Shape, width: number, bevel: number) {
  const g = new THREE.ExtrudeGeometry(sh, { depth: width - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 2, curveSegments: 10 });
  return g.rotateY(-Math.PI / 2).translate((width - 2 * bevel) / 2, 0, 0);   // shape x -> +z, depth -> -x, centred
}

// Rear-drive coupe. Origin is the centre of mass (0.45 m above the road); wheel centres sit at y = -0.12.
export function buildDriftMesh(spec: CarInfo): CarMesh {
  const root = new THREE.Group(), bodyGroup = new THREE.Group();
  root.add(bodyGroup);
  const body = mat({ color: 0xf2f4f7, roughness: 0.3, metalness: 0.1 });
  const dark = mat({ color: 0x16181c, roughness: 0.5, metalness: 0.3, envMapIntensity: 0.35 });
  const glass = mat({ color: 0x1b2633, roughness: 0.08, metalness: 0.6, envMapIntensity: 1, transparent: true, opacity: 0.45, depthWrite: false });   // see-through for the onboard camera
  const accent = mat({ color: 0xff6a13, roughness: 0.35, metalness: 0.2 });
  const { add, done } = parts(bodyGroup);

  const lower = profile([[-2.16, -0.22], [-2.08, -0.3], [2.05, -0.3], [2.2, -0.15], [2.2, 0.05], [2.12, 0.2], [0.75, 0.36], [-1.5, 0.38], [-2.06, 0.36], [-2.18, 0.2]],
    [spec.zRear, spec.zFront], { y: -0.12, r: 0.37, bottom: -0.3 });
  add(extrude(lower, 1.64, 0.05), body, 0, 0, 0);
  const cabin = new THREE.Shape([new THREE.Vector2(0.78, 0.35), new THREE.Vector2(-0.05, 0.74), new THREE.Vector2(-0.95, 0.74), new THREE.Vector2(-1.52, 0.37)]);
  add(extrude(cabin, 1.38, 0.04), glass, 0, 0, 0);
  add(B(1.3, 0.035, 0.92), body, 0, 0.755, -0.5);                                    // roof
  for (const s of [-1, 1]) {
    add(B(0.05, 0.05, 0.9), body, s * 0.66, 0.555, 0.36, 0.44);                       // A-pillars
    add(B(0.06, 0.05, 0.66), body, s * 0.67, 0.56, -1.23, -0.58);                     // C-pillars
    add(B(0.04, 0.08, 0.13), body, s * 0.8, 0.43, 0.62);                               // mirrors
  }
  add(B(0.32, 0.012, 0.92), accent, 0, 0.776, -0.5);                                 // roof stripe
  add(B(1.3, 0.12, 0.5), dark, 0, 0.35, 0.35);                                       // dashboard
  add(B(1.26, 0.01, 0.9), dark, 0, 0.732, -0.5);                                     // headliner
  add(B(0.3, 0.07, 0.14), dark, -0.36, 0.43, 0.22, 0.2);                             // instrument binnacle
  add(B(0.24, 0.03, 0.5), dark, 0, 0.3, -0.2);                                       // centre console
  // right-hand drive (x is left)
  const cockpit = addDriver(bodyGroup, add, { x: -0.36, head: [0.6, -0.45], helmet: 0xff6a13, suit: 0x23272e, shoulder: [-0.2, 0.02],
    wheel: { y: 0.38, z: -0.03, rake: 0.4, r: 0.18 }, ratio: 9, look: 0.35 });
  add(B(0.32, 0.012, 1.3), accent, 0, 0.29, 1.44, 0.116);                            // bonnet stripe
  add(B(1.74, 0.04, 0.26), dark, 0, -0.3, 2.08);                                     // front splitter
  add(B(0.9, 0.09, 0.02), dark, 0, -0.05, 2.205);                                    // intake
  add(B(1.6, 0.1, 0.16), dark, 0, -0.26, -2.12);                                     // rear valance
  for (const s of [-1, 1]) add(B(0.06, 0.07, 1.8), dark, s * 0.83, -0.28, 0);        // side skirts
  add(new THREE.CylinderGeometry(0.045, 0.045, 0.12, 10), dark, 0.5, -0.24, -2.2, Math.PI / 2);   // exhaust
  add(B(1.54, 0.05, 0.32), body, 0, 0.41, -2.0, 0.28);                              // ducktail spoiler
  const headMat = new THREE.MeshStandardMaterial({ color: 0x777766, emissive: 0xfff4d0, emissiveIntensity: 0.6 });
  for (const s of [-1, 1]) add(B(0.34, 0.07, 0.03), headMat, s * 0.56, 0.135, 2.172, -0.49);
  done();
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1010, emissiveIntensity: 0.4 });
  const tails = [-1, 1].map((s) => {
    const t = new THREE.Mesh(B(0.4, 0.08, 0.03), tailMat); t.position.set(s * 0.54, 0.1, -2.185); bodyGroup.add(t); return t;
  });
  const brakeLight = tails[1];   // both lights share tailMat, so lighting one lights both
  const wheels = buildWheels(root, spec, { rim: 0xb8bec6 });
  return { root, wheels, brakeLight, cockpit };
}

// GT3 coupe: long bonnet, cabin set back, wide arches standing above it, splitter, diffuser and a full-width rear
// wing. Origin is the centre of mass (0.40 m above the road); the floor is at y = -0.33.
export function buildGt3Mesh(spec: CarInfo, paint: Paint = { body: 0x0e6b57, accent: 0xf2d21b, stripe: 0xf2d21b }): CarMesh {
  const root = new THREE.Group(), bodyGroup = new THREE.Group();
  root.add(bodyGroup);
  const body = mat({ color: paint.body, roughness: 0.28, metalness: 0.3 });
  const dark = mat({ color: 0x16181c, roughness: 0.5, metalness: 0.3, envMapIntensity: 0.35 });
  const carbon = mat({ color: 0x24272c, roughness: 0.35, metalness: 0.5, envMapIntensity: 0.35 });
  const glass = mat({ color: 0x1b2633, roughness: 0.08, metalness: 0.6, envMapIntensity: 1, transparent: true, opacity: 0.45, depthWrite: false });
  const accent = mat({ color: paint.accent, roughness: 0.35, metalness: 0.2 });
  const { add, done } = parts(bodyGroup);
  const wheelY = spec.wheelRadius - spec.comHeight, arch = { y: wheelY, r: spec.wheelRadius + 0.05, bottom: -0.33 };

  // Centre section: low nose, long bonnet rising to the windscreen, tail.
  const core = profile([[-2.3, -0.2], [-2.22, -0.33], [2.1, -0.33], [2.3, -0.26], [2.3, -0.1], [2.08, 0.1], [0.5, 0.32], [-1.6, 0.4], [-2.28, 0.38], [-2.36, 0.2]], [], arch);
  add(extrude(core, 1.46, 0.05), body, 0, 0, 0);
  // Flanks: sills and the arches over each axle, standing above the bonnet and the tail.
  const flank = profile([[-2.3, -0.18], [-2.22, -0.33], [2.06, -0.33], [2.26, -0.25], [2.26, -0.06], [2.02, 0.26], [spec.zFront, 0.42], [0.5, 0.36], [-0.6, 0.36],
    [spec.zRear, 0.46], [-2.26, 0.42], [-2.34, 0.2]], [spec.zRear, spec.zFront], arch);
  for (const s of [-1, 1]) add(extrude(flank, 0.32, 0.04), body, s * 0.86, 0, 0);
  const cabin = new THREE.Shape([new THREE.Vector2(0.48, 0.31), new THREE.Vector2(-0.3, 0.8), new THREE.Vector2(-1.0, 0.8), new THREE.Vector2(-1.95, 0.39)]);
  add(extrude(cabin, 1.34, 0.04), glass, 0, 0, 0);
  add(B(1.26, 0.035, 0.72), body, 0, 0.815, -0.65);                                  // roof
  add(B(0.3, 0.06, 0.4), dark, 0, 0.85, -0.5);                                       // roof scoop
  for (const s of [-1, 1]) {
    add(B(0.05, 0.05, 0.94), body, s * 0.64, 0.565, 0.09, 0.56);                      // A-pillars
    add(B(0.06, 0.05, 1.04), body, s * 0.65, 0.6, -1.47, -0.41);                      // C-pillars
    add(B(0.05, 0.09, 0.14), body, s * 0.84, 0.5, 0.42);                               // mirrors
    add(B(0.26, 0.012, 0.5), dark, s * 0.36, 0.25, 1.2, 0.14);                        // bonnet vents
    add(B(0.3, 0.02, 0.2), carbon, s * 0.93, -0.12, 2.24, -0.2);                      // dive planes
    add(B(0.07, 0.08, 1.9), carbon, s * 0.98, -0.3, 0.05);                            // side skirts
    add(B(0.04, 0.16, 0.5), dark, s * 1.025, -0.02, 0.62);                            // vent behind the front wheel
    add(B(0.035, 0.36, 0.34), carbon, s * 0.52, 0.6, -2.12);                          // wing pylons
    add(B(0.03, 0.3, 0.46), carbon, s * 0.99, 0.8, -2.24);                            // wing end plates
  }
  add(B(0.3, 0.012, 1.56), accent, 0, 0.24, 1.3, 0.139);                             // bonnet stripe
  add(B(0.3, 0.012, 0.72), accent, 0, 0.836, -0.65);                                 // roof stripe
  add(B(1.3, 0.14, 0.45), carbon, 0, 0.32, 0.07);                                    // dashboard
  add(B(1.22, 0.01, 0.7), dark, 0, 0.792, -0.65);                                    // headliner
  add(B(0.28, 0.06, 0.12), dark, 0.36, 0.41, -0.05, 0.2);                            // display hood
  add(B(0.26, 0.03, 0.7), carbon, 0, 0.26, -0.55);                                   // centre console
  // left-hand drive (x is left)
  const cockpit = addDriver(bodyGroup, add, { x: 0.36, head: [0.63, -0.8], helmet: paint.accent, suit: paint.body, shoulder: [-0.2, 0.02],
    wheel: { y: 0.42, z: -0.4, rake: 0.35, r: 0.16 }, ratio: 12.6, look: 0.35 });
  add(B(1.98, 0.03, 0.42), carbon, 0, -0.33, 2.24);                                  // splitter
  add(B(1.1, 0.14, 0.02), dark, 0, -0.16, 2.305);                                    // grille
  add(B(1.96, 0.045, 0.4), carbon, 0, 0.79, -2.24, 0.1);                             // rear wing
  add(B(1.96, 0.03, 0.1), accent, 0, 0.84, -2.44, 0.5);                              // gurney flap
  add(B(1.7, 0.2, 0.5), carbon, 0, -0.24, -2.16, -0.3);                              // diffuser
  for (const x of [-0.6, -0.2, 0.2, 0.6]) add(B(0.025, 0.2, 0.5), dark, x, -0.24, -2.3, -0.3);   // diffuser strakes
  add(new THREE.CylinderGeometry(0.05, 0.05, 0.1, 10), dark, 0.99, -0.26, 0.2, 0, 0, Math.PI / 2);   // side exhaust
  const headMat = new THREE.MeshStandardMaterial({ color: 0x777766, emissive: 0xfff4d0, emissiveIntensity: 0.6 });
  for (const s of [-1, 1]) add(B(0.22, 0.07, 0.03), headMat, s * 0.86, 0.1, 2.16, -0.9);
  done();
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1010, emissiveIntensity: 0.4 });
  for (const s of [-1, 1]) {
    const t = new THREE.Mesh(B(0.5, 0.06, 0.03), tailMat); t.position.set(s * 0.6, 0.27, -2.335); bodyGroup.add(t);
  }
  const brakeLight = new THREE.Mesh(B(0.3, 0.04, 0.03), tailMat);   // shares tailMat, so lighting it lights all three
  brakeLight.position.set(0, 0.05, -2.37); bodyGroup.add(brakeLight);
  const wheels = buildWheels(root, spec, { rim: 0x1b1d21, stripe: paint.stripe });
  return { root, wheels, brakeLight, cockpit };
}
