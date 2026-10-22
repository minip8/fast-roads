import * as THREE from 'three';
import type { CarSpec } from './cars';

export interface CarMesh {
  root: THREE.Group;                 // follows the physics body
  body: THREE.Group;
  wheels: { pivot: THREE.Group; spinner: THREE.Group }[];   // pivot: steer + suspension; spinner: rolling
  brakeLight: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
}

// Returns add(geometry, material, position, rotation): a shadow-casting mesh added to the group.
function adder(group: THREE.Group) {
  return <M extends THREE.Material>(geo: THREE.BufferGeometry, mat: M, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
    const me = new THREE.Mesh(geo, mat); me.position.set(x, y, z); me.rotation.set(rx, ry, rz);
    me.castShadow = true; group.add(me); return me;
  };
}

export function buildCarMesh(spec: CarSpec): CarMesh {
  const root = new THREE.Group(), bodyGroup = new THREE.Group();
  root.add(bodyGroup);
  const body = new THREE.MeshStandardMaterial({ color: 0xff6a13, roughness: 0.35, metalness: 0.4 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x16181c, roughness: 0.5, metalness: 0.3 });
  const carbon = new THREE.MeshStandardMaterial({ color: 0x24272c, roughness: 0.35, metalness: 0.5 });
  const accent = new THREE.MeshStandardMaterial({ color: 0x1fa6ff, roughness: 0.4, metalness: 0.3 });
  const add = adder(bodyGroup);
  const B = (w: number, h: number, l: number) => new THREE.BoxGeometry(w, h, l);
  add(B(1.35, 0.04, 3.4), carbon, 0, -0.2, -0.05);                       // floor
  add(B(0.66, 0.42, 2.2), body, 0, 0.0, 0.25);                            // tub
  add(B(0.36, 0.2, 1.6), body, 0, -0.06, 1.95, 0.07);                     // nose
  add(B(0.22, 0.12, 0.4), accent, 0, -0.12, 2.75, 0.07);                  // nose tip
  add(B(1.9, 0.03, 0.5), carbon, 0, -0.23, 2.75);                         // front wing
  add(B(1.7, 0.03, 0.25), accent, 0, -0.16, 2.6, -0.25);                  // flap
  for (const s of [-1, 1]) add(B(0.03, 0.22, 0.6), carbon, s * 0.95, -0.15, 2.75);
  for (const s of [-1, 1]) add(B(0.48, 0.34, 1.5), body, s * 0.55, -0.04, -0.1);   // sidepods
  for (const s of [-1, 1]) add(B(0.06, 0.3, 0.08), dark, s * 0.8, -0.04, 0.68);
  add(B(0.48, 0.42, 1.5), body, 0, 0.22, -0.9, -0.08);                    // engine cover
  add(B(0.24, 0.28, 0.55), dark, 0, 0.52, -0.25);                         // airbox
  add(B(0.12, 0.35, 1.0), body, 0, 0.5, -0.9, -0.15);                     // shark fin
  add(B(0.44, 0.05, 0.75), dark, 0, 0.215, 0.35);                         // cockpit opening
  add(new THREE.SphereGeometry(0.135, 16, 12), new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: 0.2, metalness: 0.2 }), 0, 0.33, 0.12);
  const halo = add(new THREE.TorusGeometry(0.28, 0.025, 6, 20, Math.PI), carbon, 0, 0.42, 0.25, Math.PI / 2, 0, Math.PI);
  halo.scale.set(1, 1.3, 1);
  add(B(0.05, 0.2, 0.05), carbon, 0, 0.33, 0.62, 0.3);                     // halo strut
  add(B(1.0, 0.05, 0.36), carbon, 0, 0.6, -2.05, 0.12);                   // rear wing main
  add(B(1.0, 0.04, 0.22), accent, 0, 0.72, -2.15, 0.35);                  // rear flap
  for (const s of [-1, 1]) add(B(0.03, 0.55, 0.6), carbon, s * 0.5, 0.42, -2.05);
  add(B(0.06, 0.45, 0.25), carbon, 0, 0.32, -1.95);                       // pylon
  add(B(0.9, 0.18, 0.5), carbon, 0, -0.18, -1.9);                         // diffuser
  const brakeLight = add(B(0.12, 0.08, 0.03), new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1010, emissiveIntensity: 0.4 }), 0, 0.05, -2.32);
  // suspension arms
  for (const [x, z] of [[1, spec.zFront], [-1, spec.zFront], [1, spec.zRear], [-1, spec.zRear]]) {
    add(B(0.62, 0.025, 0.06), dark, x * 0.5, 0.06, z, 0, 0, -x * 0.12);
    add(B(0.62, 0.025, 0.06), dark, x * 0.5, -0.05, z + 0.08, 0, 0, x * 0.05);
  }
  const wheels = buildWheels(root, spec, dark);
  return { root, body: bodyGroup, wheels, brakeLight };
}

// Four wheels (pivot for steer/suspension, spinner for rolling) shared by every car body.
export function buildWheels(root: THREE.Group, spec: CarSpec, dark: THREE.Material): CarMesh['wheels'] {
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.85 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.3, metalness: 0.8 });
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0xffd23f, roughness: 0.6 });
  const wheels: CarMesh['wheels'] = [];
  for (const [x, , front] of [[spec.trackHalf, spec.zFront, 1], [-spec.trackHalf, spec.zFront, 1], [spec.trackHalf, spec.zRear, 0], [-spec.trackHalf, spec.zRear, 0]]) {
    const pivot = new THREE.Group(), spinner = new THREE.Group();
    const w = spec.tyreW[front ? 0 : 1], r = spec.wheelRadius;
    const tyre = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 28), tyreMat); tyre.rotation.z = Math.PI / 2; tyre.castShadow = true;
    const side = Math.sign(x);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.6, r * 0.6, 0.02, 20), rimMat); rim.rotation.z = Math.PI / 2; rim.position.x = side * (w / 2 + 0.005);
    const stripe = new THREE.Mesh(new THREE.TorusGeometry(r * 0.82, 0.012, 4, 28), stripeMat); stripe.rotation.y = Math.PI / 2; stripe.position.x = side * (w / 2 + 0.004);
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.03, r * 1.1, 0.05), dark); spoke.position.x = side * (w / 2 + 0.015);
    spinner.add(tyre, rim, stripe, spoke);
    pivot.add(spinner); root.add(pivot);
    wheels.push({ pivot, spinner });
  }
  return wheels;
}

// Boxy rear-drive coupe. Origin is the centre of mass (about 0.45 m above the road).
export function buildDriftMesh(spec: CarSpec): CarMesh {
  const root = new THREE.Group(), bodyGroup = new THREE.Group();
  root.add(bodyGroup);
  const body = new THREE.MeshStandardMaterial({ color: 0xf2f4f7, roughness: 0.3, metalness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x16181c, roughness: 0.5, metalness: 0.3 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1b2633, roughness: 0.1, metalness: 0.6, transparent: true, opacity: 0.45, depthWrite: false });   // see-through for the onboard camera
  const accent = new THREE.MeshStandardMaterial({ color: 0xff6a13, roughness: 0.4, metalness: 0.3 });
  const add = adder(bodyGroup);
  const B = (w: number, h: number, l: number) => new THREE.BoxGeometry(w, h, l);
  add(B(1.64, 0.36, 4.3), body, 0, 0.1, 0);                                // main body (narrower than the track so tyres show)
  add(B(1.58, 0.08, 1.35), body, 0, 0.31, 1.42, 0.05);                     // bonnet
  add(B(1.4, 0.42, 1.75), glass, 0, 0.49, -0.35);                          // cabin glass
  add(B(1.36, 0.05, 1.25), body, 0, 0.72, -0.45);                          // roof
  add(B(1.34, 0.04, 0.7), glass, 0, 0.5, 0.66, -0.85);                   // windscreen
  add(B(0.32, 0.01, 1.25), accent, 0, 0.75, -0.45);                       // roof stripe
  add(B(0.32, 0.01, 1.3), accent, 0, 0.355, 1.42, 0.05);                  // bonnet stripe
  add(B(1.74, 0.1, 0.3), dark, 0, -0.07, 2.1);                             // front splitter
  add(B(1.7, 0.14, 0.2), dark, 0, -0.03, -2.12);                           // rear bumper
  for (const s of [-1, 1]) add(B(0.06, 0.1, 2.0), dark, s * 0.83, -0.07, 0);   // side skirts
  add(B(1.54, 0.05, 0.38), body, 0, 0.34, -2.0, 0.28);                     // ducktail spoiler
  const headMat = new THREE.MeshStandardMaterial({ color: 0x777766, emissive: 0xfff4d0, emissiveIntensity: 0.6 });
  for (const s of [-1, 1]) add(B(0.34, 0.08, 0.03), headMat, s * 0.56, 0.18, 2.16);
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1010, emissiveIntensity: 0.4 });
  const tails = [-1, 1].map((s) => add(B(0.4, 0.08, 0.03), tailMat, s * 0.54, 0.18, -2.16));
  const brakeLight = tails[1];   // both lights share tailMat, so lighting one lights both
  const wheels = buildWheels(root, spec, dark);
  return { root, body: bodyGroup, wheels, brakeLight };
}
