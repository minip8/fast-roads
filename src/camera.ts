import * as THREE from 'three';
import { S_ASPHALT, S_GRAVEL } from './config';
import type { Stage } from './stage';
import { clamp } from './util';
import type { Vehicle } from './vehicle';

// ============================================================================
// Camera rig: onboard or the driver's eyes (fixed to the car), or a smoothed chase camera
// ============================================================================
export const CAM_MODES = ['onboard', 'driver', 'chase', 'far'] as const;   // C cycles in this order
export type CamMode = (typeof CAM_MODES)[number];

const _shake = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

export class CameraRig {
  mode: CamMode = 'onboard';
  private readonly off = new THREE.Vector3();    // chase: smoothed camera offset from the car (world axes)
  private readonly look = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3(0, 0, 1);
  private y = 0;                                  // chase: smoothed car height, so kerb hops don't jolt the view
  private fov = 66;
  private rumble = 0;                             // 0..1, eased: how rough the surface under the car is
  private t = 0;                                  // shake phase: advances with distance driven, so a paused car is still
  private readonly lastP = new THREE.Vector3();
  private init = false;

  constructor(private readonly stage: Stage) {}

  // Snap the chase camera behind the car next frame (after a reset or teleport).
  reset() { this.init = false; }

  update(dt: number, car: Vehicle) {
    const { camera, sky } = this.stage;
    const root = car.mesh.root, p = root.position;
    const fwd = _v1.set(0, 0, 1).applyQuaternion(root.quaternion);
    const speed = Math.abs(car.speedF);
    this.t += Math.min(p.distanceTo(this.lastP), 5) / 30; this.lastP.copy(p);

    // Surface rumble: a light shake on kerbs, grass and gravel, growing with speed.
    let rough = 0;
    for (const w of car.wheels) if (w.grounded && w.surf !== S_ASPHALT) rough += w.surf === S_GRAVEL ? 1 : 0.6;
    this.rumble += (clamp(rough / 4, 0, 1) * clamp(speed / 30, 0, 1) - this.rumble) * (1 - Math.exp(-dt * 10));
    const t = this.t, amp = this.rumble * 0.018;
    _shake.set(Math.sin(t * 71) + Math.sin(t * 113) * 0.5, Math.sin(t * 89 + 1) + Math.sin(t * 131 + 2) * 0.5, 0).multiplyScalar(amp);

    let fov: number;
    car.mesh.cockpit.head.visible = this.mode !== 'driver';   // the camera is inside the helmet
    if (this.mode === 'driver') {
      const upv = _v2.set(0, 1, 0).applyQuaternion(root.quaternion), c = car.mesh.cockpit;
      camera.position.copy(c.eye).applyQuaternion(root.quaternion).add(p);
      camera.lookAt(_v3.copy(camera.position).addScaledVector(fwd, 10).addScaledVector(upv, -c.look));
      camera.position.add(_shake);
      fov = 70 + clamp(speed, 0, 90) * 0.04;
    } else if (this.mode === 'onboard') {
      const upv = _v2.set(0, 1, 0).applyQuaternion(root.quaternion);
      const cam = car.spec.cam;
      camera.position.copy(p).addScaledVector(upv, cam.up).addScaledVector(fwd, -cam.back);
      camera.lookAt(_v3.copy(camera.position).addScaledVector(fwd, 10).addScaledVector(upv, -cam.down));
      camera.position.add(_shake);
      fov = 76 + clamp(speed, 0, 90) * 0.05;
    } else {
      // Heading is smoothed (the car visibly yaws and slides in front of the camera), but the camera is attached to
      // the car's position rather than chasing it, so it stays the same distance behind at any speed. Moving
      // forwards, the camera aims between the car's heading and its direction of travel, so a slide shows the car
      // angled across the view instead of swinging the camera round with it.
      const flat = _v2.set(fwd.x, 0, fwd.z).normalize();
      const v = car.vel, vh = Math.hypot(v.x, v.z), wv = car.speedF > 2 ? clamp((vh - 3) / 12, 0, 1) : 0;
      if (wv > 0) flat.set(flat.x + (v.x / vh) * wv, 0, flat.z + (v.z / vh) * wv).normalize();
      const far = this.mode === 'far';
      const dist = (far ? 9.5 : 6.2) + clamp(speed, 0, 90) * (far ? 0.016 : 0.01), h = far ? 3.0 : 1.75;
      if (!this.init) { this.fwd.copy(flat); this.y = p.y; this.init = true; this.off.set(0, 0, 0); }
      this.fwd.lerp(flat, 1 - Math.exp(-dt * 6)).normalize();
      this.y += (p.y - this.y) * (1 - Math.exp(-dt * 12));
      const target = _v3.copy(this.fwd).multiplyScalar(-dist); target.y = h;
      if (!this.off.lengthSq()) this.off.copy(target);
      this.off.lerp(target, 1 - Math.exp(-dt * 10));
      camera.position.set(p.x + this.off.x, this.y + this.off.y, p.z + this.off.z).add(_shake);
      this.look.copy(p).addScaledVector(this.fwd, 4); this.look.y = this.y + 0.6;
      camera.lookAt(this.look);
      fov = 64 + clamp(speed, 0, 90) * 0.1;
    }
    // ease FOV changes (mode switches, sudden stops)
    this.fov += (fov - this.fov) * (1 - Math.exp(-dt * 6));
    if (Math.abs(camera.fov - this.fov) > 1e-3) { camera.fov = this.fov; camera.updateProjectionMatrix(); }
    sky.position.copy(camera.position);
    this.stage.followSun(p, camera.getWorldDirection(_v2));
  }
}
