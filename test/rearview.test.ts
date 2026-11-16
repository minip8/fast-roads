// Looking behind: the camera rig's look-back pose in every camera mode, and the rear-view mirror's camera and flip
// (src/camera.ts, src/mirror.ts). The rendering itself needs a browser; these check the geometry.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CAM_MODES, CameraRig } from '../src/camera';
import { mirrorCameraPose, placeMirrorCamera } from '../src/mirror';
import type { Stage } from '../src/stage';
import type { Vehicle } from '../src/vehicle';
import { session } from './harness';

const fwdOf = (car: Vehicle) => new THREE.Vector3(0, 0, 1).applyQuaternion(car.mesh.root.quaternion);
const viewDir = (cam: THREE.Camera) => { cam.updateMatrixWorld(); return cam.getWorldDirection(new THREE.Vector3()); };

// A car on the start straight, rolling, with its body placed for rendering.
async function rolling(carId: 'drift' | 'lcf1') {
  const s = await session(carId, { flying: true });
  s.drive(0.5);
  s.car.render(1, 0);
  return s.car;
}

describe('look behind', () => {
  for (const carId of ['drift', 'lcf1'] as const) {
    it(`turns every camera round while held and back on release (${carId})`, async () => {
      const car = await rolling(carId);
      const camera = new THREE.PerspectiveCamera(70, 16 / 10, 0.1, 9000);
      const stage = { camera, sky: new THREE.Object3D(), followSun: () => {} } as unknown as Stage;
      const rig = new CameraRig(stage), fwd = fwdOf(car), p = car.mesh.root.position;
      for (const mode of CAM_MODES) {
        rig.mode = mode; rig.reset();
        rig.lookBack = false;
        for (let k = 0; k < 30; k++) rig.update(1 / 60, car);
        expect(viewDir(camera).dot(fwd), mode).toBeGreaterThan(0.9);
        rig.lookBack = true;
        rig.update(1 / 60, car);   // at once: no easing round
        expect(viewDir(camera).dot(fwd), mode).toBeLessThan(-0.95);
        // cockpit cameras look back over the car from above it; chase cameras from in front of it
        const rel = camera.position.clone().sub(p);
        if (mode === 'chase' || mode === 'far') expect(rel.dot(fwd), mode).toBeGreaterThan(5);
        else expect(rel.y, mode).toBeGreaterThan(0.8);
        expect(car.mesh.cockpit.head.visible, mode).toBe(true);   // the camera is never inside the helmet looking back
        rig.lookBack = false;
        rig.update(1 / 60, car);
        expect(viewDir(camera).dot(fwd), mode).toBeGreaterThan(0.9);
        expect(car.mesh.cockpit.head.visible, mode).toBe(mode !== 'driver');
      }
    });
  }
});

describe('rear-view mirror', () => {
  it('looks back from the driver’s eyes and shows the left on the left, as a mirror does', async () => {
    const car = await rolling('drift');
    const cam = new THREE.PerspectiveCamera(19, 4, 0.3, 1200), root = car.mesh.root, fwd = fwdOf(car);
    placeMirrorCamera(cam, car);
    expect(viewDir(cam).dot(fwd)).toBeLessThan(-0.99);
    expect(cam.position.distanceTo(car.mesh.cockpit.eye.clone().applyQuaternion(root.quaternion).add(root.position))).toBeLessThan(1e-6);
    cam.updateProjectionMatrix();

    // 20 m behind the car and 4 m to its left (body +x), a little above the road
    const q = new THREE.Vector3(4, 0.5, -20).applyQuaternion(root.quaternion).add(root.position);
    const plain = q.clone().project(cam);
    expect(plain.x).toBeGreaterThan(0.05);   // a plain rear camera shows it on the right
    // The mirror pass draws the mirrored scene (x negated) from the mirrored pose.
    const mirrored = cam.clone();
    mirrorCameraPose(mirrored);
    mirrored.updateMatrixWorld();
    const seen = q.clone().setX(-q.x).project(mirrored);
    expect(seen.x).toBeCloseTo(-plain.x, 6);   // the mirror shows it on the left, where the driver would see it
    expect(seen.y).toBeCloseTo(plain.y, 6);
    expect(seen.z).toBeCloseTo(plain.z, 6);
    expect(new THREE.Matrix4().makeRotationFromQuaternion(mirrored.quaternion).determinant()).toBeCloseTo(1, 9);   // still a proper camera
  });
});
