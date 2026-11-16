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
const _m = new THREE.Matrix4(), _box = new THREE.Box3();

// The car body's bounding box in its own frame (x left, y up, z forward), wheels included.
export function bodyBox(root: THREE.Object3D, out: THREE.Box3) {
  root.updateMatrixWorld(true);
  const inv = _m.copy(root.matrixWorld).invert(), m = new THREE.Matrix4();
  out.makeEmpty();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const g = o.geometry as THREE.BufferGeometry;
    if (!g.boundingBox) g.computeBoundingBox();
    out.union(_box.copy(g.boundingBox!).applyMatrix4(m.multiplyMatrices(inv, o.matrixWorld)));
  });
  return out;
}

export class CameraRig {
  mode: CamMode = 'onboard';
  hands = false;                                  // show the driver's arms and gloves in the driver camera
  fovOffset = 0;                                  // degrees added to every mode's field of view (setting)
  speedFov = true;                                // widen the view with speed (setting)
  shake = true;                                   // surface rumble shake (setting)
  lookBack = false;                               // held: look behind the car (set every frame from the input)
  private readonly off = new THREE.Vector3();    // chase: smoothed camera offset from the car (world axes)
  private readonly look = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3(0, 0, 1);
  private y = 0;                                  // chase: smoothed car height, so kerb hops don't jolt the view
  private fov = 66;
  private rumble = 0;                             // 0..1, eased: how rough the surface under the car is
  private t = 0;                                  // shake phase: advances with distance driven, so a paused car is still
  private readonly lastP = new THREE.Vector3();
  private init = false;
  private readonly box = new THREE.Box3();        // the car body's bounds (for looking back over it)
  private boxOf: object | null = null;            // the cockpit it was measured with: a car model swap replaces it

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
    const t = this.t, amp = this.shake ? this.rumble * 0.018 : 0;
    _shake.set(Math.sin(t * 71) + Math.sin(t * 113) * 0.5, Math.sin(t * 89 + 1) + Math.sin(t * 131 + 2) * 0.5, 0).multiplyScalar(amp);

    let fov: number;
    const sp = this.speedFov ? clamp(speed, 0, 90) : 0;   // the speed that widens the view
    const c = car.mesh.cockpit, back = this.lookBack, inside = this.mode === 'driver' && !back;
    c.head.visible = !inside;   // the camera is inside the helmet
    for (const arm of c.arms) arm.mesh.visible = arm.glove.visible = !inside || this.hands;
    if (back && (this.mode === 'driver' || this.mode === 'onboard')) {
      // From the cockpit: over the back of the car, looking back past the tail (which shows at the bottom).
      if (this.boxOf !== c) { bodyBox(car.mesh.root, this.box); this.boxOf = c; }
      const b = this.box, upv = _v2.set(0, 1, 0).applyQuaternion(root.quaternion);
      camera.position.set(0, b.max.y + 0.6, b.min.z + 0.5 * (b.max.z - b.min.z)).applyQuaternion(root.quaternion).add(p);
      camera.lookAt(_v3.copy(camera.position).addScaledVector(fwd, -10).addScaledVector(upv, -0.9));
      camera.position.add(_shake);
      fov = 70 + sp * 0.04;
    } else if (this.mode === 'driver') {
      const upv = _v2.set(0, 1, 0).applyQuaternion(root.quaternion);
      camera.position.copy(c.eye).applyQuaternion(root.quaternion).add(p);
      camera.lookAt(_v3.copy(camera.position).addScaledVector(fwd, 10).addScaledVector(upv, -c.look));
      camera.position.add(_shake);
      fov = 70 + sp * 0.04;
    } else if (this.mode === 'onboard') {
      const upv = _v2.set(0, 1, 0).applyQuaternion(root.quaternion);
      const cam = car.spec.cam;
      camera.position.copy(p).addScaledVector(upv, cam.up).addScaledVector(fwd, -cam.back);
      camera.lookAt(_v3.copy(camera.position).addScaledVector(fwd, 10).addScaledVector(upv, -cam.down));
      camera.position.add(_shake);
      fov = 76 + sp * 0.05;
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
      if (back) {
        // the same distance in front, looking back at the car and past it
        camera.position.set(p.x - this.off.x, this.y + this.off.y, p.z - this.off.z).add(_shake);
        this.look.copy(p).addScaledVector(this.fwd, -4); this.look.y = this.y + 0.6;
      } else {
        camera.position.set(p.x + this.off.x, this.y + this.off.y, p.z + this.off.z).add(_shake);
        this.look.copy(p).addScaledVector(this.fwd, 4); this.look.y = this.y + 0.6;
      }
      camera.lookAt(this.look);
      fov = 64 + sp * 0.1;
    }
    fov += this.fovOffset;
    // ease FOV changes (mode switches, sudden stops)
    this.fov += (fov - this.fov) * (1 - Math.exp(-dt * 6));
    if (Math.abs(camera.fov - this.fov) > 1e-3) { camera.fov = this.fov; camera.updateProjectionMatrix(); }
    sky.position.copy(camera.position);
    this.stage.followSun(p, camera.getWorldDirection(_v2));
  }
}
