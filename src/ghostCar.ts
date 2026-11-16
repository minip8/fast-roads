import * as THREE from 'three';
import { poseCockpit, type CarMesh, type Cockpit } from './carMeshes';
import { DT } from './config';
import { ghostPose, type GhostPose } from './ghost';
import type { Timing } from './timing';
import type { Vehicle } from './vehicle';

// ============================================================================
// Ghost car: the best lap here in this car (Timing.ghost), replayed as a translucent copy of the car's body in step
// with the lap under way. No physics, no collision, no shadow. It appears at the line when the lap starts and
// disappears there when its own lap ends, and fades out near the camera so it never blocks the view.
// ============================================================================
const OPACITY = 0.42;
const FADE_NEAR = 3, FADE_FAR = 8;     // m from the camera: invisible inside NEAR, full opacity beyond FAR
const TINT = new THREE.Color(0x9fd8ff);

const _pose: GhostPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, steer: 0, dist: 0 };
const _e = new THREE.Euler(0, 0, 0, 'YXZ');

export class GhostCar {
  enabled = true;                      // the Ghost car setting
  readonly mapPos = { x: 0, z: 0 };    // where it is, for the minimap (valid while shown)
  shown = false;                       // drawn this frame
  private mesh: CarMesh | null = null;
  private specId = '';
  private cockpit: Cockpit | null = null;   // changes when a car model is swapped in: the new parts need ghosting
  private readonly mats: THREE.Material[] = [];
  private opacity = -1;
  // Fills the depth buffer with the ghost's front surfaces before its colour is drawn, so it reads as one
  // translucent shell rather than every inner panel showing through.
  private readonly depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true });

  constructor(private readonly scene: THREE.Scene) { this.depthMat.userData.shared = true; }

  // Each frame, before rendering: the car being driven (the ghost is its body), and the camera it is seen from.
  update(car: Vehicle, timing: Timing, simTime: number, alpha: number, camera: THREE.Camera) {
    const g = timing.ghost, lapStart = timing.lapStart;
    // the lap time of the pose the car is drawn at (it is interpolated a tick behind simTime)
    const t = lapStart == null ? -1 : simTime - (1 - alpha) * DT - lapStart;
    if (this.mesh && car.spec.id !== this.specId) this.removeMesh();   // another car: its body is built when next shown
    this.shown = this.enabled && g != null && t >= g.t0 && t <= g.lapTime;
    if (!this.shown) { if (this.mesh) this.mesh.root.visible = false; return; }
    if (!this.mesh) this.build(car);
    const m = this.mesh!;
    if (m.cockpit !== this.cockpit) this.ghostify(m);

    const p = ghostPose(g!, t, _pose);
    m.root.position.set(p.x, p.y, p.z);
    m.root.quaternion.setFromEuler(_e.set(p.pitch, p.yaw, p.roll, 'YXZ'));
    const own = car.mesh.wheels, spin = p.dist / car.spec.wheelRadius;
    for (let k = 0; k < m.wheels.length; k++) {
      const w = m.wheels[k];
      w.pivot.position.copy(own[k].pivot.position);   // the car's own suspension: not recorded, and close enough
      w.pivot.rotation.y = k < 2 ? p.steer : 0;
      w.spinner.rotation.x = spin;
    }
    poseCockpit(m.cockpit, p.steer);
    this.mapPos.x = p.x; this.mapPos.z = p.z;
    this.fade(camera);
  }

  // Fade it for the camera it is about to be seen from (also the rear-view mirror's, for its pass).
  fade(camera: THREE.Camera) {
    const m = this.mesh;
    if (!this.shown || !m) return;
    const d = camera.position.distanceTo(m.root.position);
    const a = OPACITY * Math.min(1, Math.max(0, (d - FADE_NEAR) / (FADE_FAR - FADE_NEAR)));
    m.root.visible = a > 0.01;
    if (Math.abs(a - this.opacity) > 0.005) { this.opacity = a; for (const mat of this.mats) mat.opacity = a; }
  }

  dispose() { this.removeMesh(); this.depthMat.dispose(); }

  private removeMesh() {
    if (this.mesh) { this.scene.remove(this.mesh.root); this.mesh.dispose(); }
    this.mesh = null; this.specId = ''; this.cockpit = null; this.mats.length = 0;
  }

  // The car's body, built again for the ghost (and rebuilt when the car is switched).
  private build(car: Vehicle) {
    this.removeMesh();
    this.specId = car.spec.id;
    this.mesh = car.spec.mesh(car.spec);
    this.mesh.root.name = 'ghost';
    this.scene.add(this.mesh.root);
    this.ghostify(this.mesh);
  }

  // Every part not yet ghosted gets a translucent copy of its material (the originals may be a loaded model's,
  // shared with the player's car: never changed), casts no shadow, and gets a depth-only twin drawn first.
  private ghostify(m: CarMesh) {
    this.cockpit = m.cockpit;
    if (m.cockpit.screen) m.cockpit.screen.mesh.visible = false;   // no live instruments in the ghost
    const copies = new Map<THREE.Material, THREE.Material>(), parts: THREE.Mesh[] = [];
    m.root.traverse((o) => { if (o instanceof THREE.Mesh && !o.userData.ghost) parts.push(o); });
    this.mats.length = 0;
    for (const o of parts) {
      o.userData.ghost = true;
      o.castShadow = o.receiveShadow = false;
      const ghostMat = (src: THREE.Material) => {
        let c = copies.get(src);
        if (!c) {
          c = src.clone();
          c.userData = {};
          c.transparent = true; c.depthWrite = false; c.opacity = OPACITY;
          if (c instanceof THREE.MeshPhysicalMaterial) c.transmission = 0;
          if (c instanceof THREE.MeshStandardMaterial) { c.emissive.copy(TINT); c.emissiveIntensity = 0.18; c.envMapIntensity *= 0.5; }
          copies.set(src, c);
          if (!src.userData.shared) src.dispose();
        }
        return c;
      };
      o.material = Array.isArray(o.material) ? o.material.map(ghostMat) : ghostMat(o.material as THREE.Material);
      o.renderOrder = 11;
      const depth = new THREE.Mesh(o.geometry, this.depthMat);
      depth.userData.ghost = true; depth.renderOrder = 10;
      o.add(depth);
    }
    // the parts already ghosted before a model swap are gone (their materials with them): keep the live ones
    m.root.traverse((o) => { if (o instanceof THREE.Mesh && o.material !== this.depthMat) for (const mat of [o.material as THREE.Material | THREE.Material[]].flat()) if (!this.mats.includes(mat)) this.mats.push(mat); });
    this.opacity = -1;
  }
}
