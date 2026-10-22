import * as THREE from 'three';
import { _v1, _v2, _v3, type Car } from './car';
import type { Stage } from './stage';
import { clamp } from './util';

// ============================================================================
// Camera rig: onboard (fixed to the car), or a smoothed chase camera
// ============================================================================
export const CAM_MODES = ['onboard', 'chase', 'far'] as const;   // C cycles in this order
export type CamMode = (typeof CAM_MODES)[number];

export class CameraRig {
  mode: CamMode = 'onboard';
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3(0, 0, 1);
  private init = false;

  constructor(private readonly stage: Stage) {}

  // Snap the chase camera behind the car next frame (after a reset or teleport).
  reset() { this.init = false; this.pos.set(0, 0, 0); }

  update(dt: number, car: Car) {
    const { camera, sky, sun, sunDir } = this.stage;
    const root = car.mesh.root, p = root.position;
    const fwd = _v1.set(0, 0, 1).applyQuaternion(root.quaternion);
    if (this.mode === 'onboard') {
      const upv = _v2.set(0, 1, 0).applyQuaternion(root.quaternion);
      const cam = car.spec.cam;
      camera.position.copy(p).addScaledVector(upv, cam.up).addScaledVector(fwd, -cam.back);
      camera.lookAt(_v3.copy(camera.position).addScaledVector(fwd, 10).addScaledVector(upv, -cam.down));
      camera.fov = 78;
    } else {
      const flat = _v2.set(fwd.x, 0, fwd.z).normalize();
      if (!this.init) { this.fwd.copy(flat); this.init = true; }
      this.fwd.lerp(flat, 1 - Math.exp(-dt * 7)).normalize();
      const far = this.mode === 'far', dist = far ? 9.5 : 6.2, h = far ? 3.0 : 1.75;
      const target = _v3.copy(p).addScaledVector(this.fwd, -dist); target.y = p.y + h;
      if (!this.pos.lengthSq()) this.pos.copy(target);
      this.pos.lerp(target, 1 - Math.exp(-dt * 14));
      camera.position.copy(this.pos);
      this.look.copy(p).addScaledVector(this.fwd, 4); this.look.y = p.y + 0.6;
      camera.lookAt(this.look);
      camera.fov = 66 + clamp(car.speedF, 0, 90) * 0.12;
    }
    camera.updateProjectionMatrix();
    sky.position.copy(camera.position);
    sun.position.copy(p).addScaledVector(sunDir, 250);
    sun.target.position.copy(p);
  }
}
