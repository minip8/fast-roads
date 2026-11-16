import * as THREE from 'three';
import type { Vehicle } from './vehicle';

// ============================================================================
// Rear-view mirror: a wide, short panel at the top of the screen showing what is behind the car, flipped left to
// right as a real mirror is. After the main view, the scene is drawn a second time into the panel's rectangle of
// the canvas (viewport + scissor), from the driver's eyes looking back, with the car's own body hidden. The panel
// (#mirror) is HUD markup: its frame is CSS, and its place and size (HUD scale, small screens) come from the page.
//
// The flip: the whole scene is mirrored (scene.scale.x = -1) and seen from the mirrored camera, turned so that it is
// a proper camera again. three.js then flips each mesh's winding itself (negative determinant), so faces cull as
// they should, and everything drawn is the true image mirrored. The shadow map is not drawn again: the sun's shadow
// matrix is mirrored for the pass instead, so the main view's shadows land in the same places.
// ============================================================================
export type MirrorMode = 'off' | 'cockpit' | 'on';   // the Rear-view mirror setting ('cockpit': Onboard and Driver cameras only)

export const MIRROR_FOV = 19;     // vertical field of view (deg): about 72 deg across the panel's 4:1
export const MIRROR_FAR = 1200;   // m: the fog has thinned most of the scenery out by then
const LOOK_DOWN = 0.35;           // m the view drops over 10 m behind (about 2 deg)

const S = new THREE.Matrix4().makeScale(-1, 1, 1);   // the mirror: world x negated
const _fwd = new THREE.Vector3(), _up = new THREE.Vector3(), _t = new THREE.Vector3();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _m = new THREE.Matrix4();
const _size = new THREE.Vector2(), _shadow = new THREE.Matrix4();

// Place a camera at the driver's eyes looking straight back along the car (the mirror's view, before the flip).
export function placeMirrorCamera(camera: THREE.PerspectiveCamera, car: Vehicle) {
  const root = car.mesh.root, q = root.quaternion;
  camera.position.copy(car.mesh.cockpit.eye).applyQuaternion(q).add(root.position);
  _fwd.set(0, 0, 1).applyQuaternion(q); _up.set(0, 1, 0).applyQuaternion(q);
  camera.up.copy(_up);
  camera.lookAt(_t.copy(camera.position).addScaledVector(_fwd, -10).addScaledVector(_up, -LOOK_DOWN));
  camera.up.set(0, 1, 0);
}

// Turn a camera's pose into the one that sees the mirrored scene (S applied to the world) as the mirror image of
// what it saw: its position mirrored, its axes mirrored with its own x axis negated so it stays right-handed.
export function mirrorCameraPose(camera: THREE.Camera) {
  camera.position.x = -camera.position.x;
  _m.makeRotationFromQuaternion(camera.quaternion).extractBasis(_x, _y, _z);
  _x.set(_x.x, -_x.y, -_x.z); _y.x = -_y.x; _z.x = -_z.x;   // -S·x, S·y, S·z
  camera.quaternion.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}

export class RearMirror {
  mode: MirrorMode = 'off';
  readonly camera = new THREE.PerspectiveCamera(MIRROR_FOV, 4, 0.3, MIRROR_FAR);
  // What the last mirror pass drew (renderer.info), for measuring its cost.
  readonly stats = { calls: 0, triangles: 0 };
  private shown = false;
  private readonly rect = { x: 0, y: 0, w: 0, h: 0 };   // CSS px inside the frame, y from the top
  private dirty = true;

  constructor(private readonly el: HTMLElement) {
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { this.dirty = true; }).observe(el);
    addEventListener('resize', () => { this.dirty = true; });
  }

  // Whether the setting wants the mirror in this camera mode.
  wanted(cockpitView: boolean) { return this.mode === 'on' || (this.mode === 'cockpit' && cockpitView); }

  // Each frame, after the main view is drawn. `show` is false when the mirror isn't wanted now (setting, camera,
  // HUD hidden, menu open, looking back): then the panel is hidden and nothing else is done.
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, sun: THREE.DirectionalLight, car: Vehicle, show: boolean,
    ghost?: { fade(camera: THREE.Camera): void }, mainCamera?: THREE.Camera) {
    if (show !== this.shown) { this.shown = show; this.el.hidden = !show; this.dirty = true; }
    if (!show) return;
    const r = this.rect;
    if (this.dirty) {
      const b = this.el.getBoundingClientRect(), bw = this.el.clientLeft * (b.width / (this.el.offsetWidth || 1));   // frame width, zoomed
      r.x = b.left + bw; r.y = b.top + bw; r.w = b.width - 2 * bw; r.h = b.height - 2 * bw;
      this.dirty = false;
    }
    if (r.w < 8 || r.h < 8) return;   // hidden by the layout (narrow screens)

    const cam = this.camera;
    if (Math.abs(cam.aspect - r.w / r.h) > 1e-4) { cam.aspect = r.w / r.h; cam.updateProjectionMatrix(); }
    placeMirrorCamera(cam, car);
    ghost?.fade(cam);   // the ghost fades by its distance from this camera, not the main one
    mirrorCameraPose(cam);

    // The mirrored scene, without the car's own body, into the panel's rectangle; the shadow map is reused.
    const body = car.mesh.root, bodyVisible = body.visible, sm = renderer.shadowMap, auto = sm.autoUpdate;
    body.visible = false; sm.autoUpdate = false;
    scene.scale.x = -1;
    _shadow.copy(sun.shadow.matrix); sun.shadow.matrix.multiply(S);
    renderer.getSize(_size);
    const y = _size.y - r.y - r.h;
    renderer.setViewport(r.x, y, r.w, r.h); renderer.setScissor(r.x, y, r.w, r.h); renderer.setScissorTest(true);
    renderer.render(scene, cam);
    this.stats.calls = renderer.info.render.calls; this.stats.triangles = renderer.info.render.triangles;
    renderer.setScissorTest(false); renderer.setViewport(0, 0, _size.x, _size.y);
    sun.shadow.matrix.copy(_shadow);
    scene.scale.x = 1;
    body.visible = bodyVisible; sm.autoUpdate = auto;
    if (ghost && mainCamera) ghost.fade(mainCamera);
  }
}
