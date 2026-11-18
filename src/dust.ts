import * as THREE from 'three';
import { bodyBox } from './camera';
import type { Cockpit } from './carMeshes';
import { S_GRASS, S_GRAVEL } from './config';
import { clamp, lerp } from './util';
import type { Vehicle } from './vehicle';

// ============================================================================
// Dust kicked up by wheels on grass / gravel (purely visual)
// ============================================================================
// Light, dry dust (lighter than the ground, so it reads against grass and gravel alike)
const COLOR_GRASS = [0.70, 0.68, 0.52], COLOR_GRAVEL = [0.86, 0.78, 0.62];
const rnd = () => Math.random() - 0.5;
const _p = new THREE.Vector3(), _qi = new THREE.Quaternion();

// A puff is a soft disc facing the camera, up to 3 m across, so one inside the car or close beside it is drawn through
// the body (and fills the cockpit cameras). keepOut moves a point p, in the car's frame, out of the body's box grown
// by `margin`, horizontally through the nearest side or end (so nothing jumps as the car moves into it); a point
// above the box is left alone. Returns whether it moved it.
export function keepOut(p: THREE.Vector3, box: THREE.Box3, margin: number): boolean {
  if (p.y >= box.max.y + margin) return false;
  const right = p.x - (box.min.x - margin), left = box.max.x + margin - p.x;
  const back = p.z - (box.min.z - margin), front = box.max.z + margin - p.z;
  const least = Math.min(right, left, back, front);
  if (least <= 0) return false;
  if (least === left) p.x += left; else if (least === right) p.x -= right;
  else if (least === back) p.z -= back; else p.z += front;
  return true;
}
const BODY_MARGIN = 0.3;   // of a puff's size: about the radius it is visible to

export class Dust {
  private next = 0;
  private wasAlive = false;               // particles were visible last frame (their buffers need uploading)
  private readonly carry = [0, 0, 0, 0];   // fractional particles owed per wheel
  // per-particle buffers: position/velocity/colour (xyz), plus alpha, size, age, lifetime, start alpha, start/end size
  private readonly pos: Float32Array<ArrayBuffer>; private readonly vel: Float32Array<ArrayBuffer>; private readonly col: Float32Array<ArrayBuffer>;
  private readonly alpha: Float32Array<ArrayBuffer>; private readonly size: Float32Array<ArrayBuffer>;
  private readonly age: Float32Array<ArrayBuffer>; private readonly life: Float32Array<ArrayBuffer>;
  private readonly a0: Float32Array<ArrayBuffer>; private readonly s0: Float32Array<ArrayBuffer>; private readonly s1: Float32Array<ArrayBuffer>;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly points: THREE.Points;
  private readonly box = new THREE.Box3();   // the car's body in its own frame
  private boxOf: Cockpit | null = null;      // (a car switch or a loaded model brings another cockpit)

  constructor(scene: THREE.Scene, private readonly max = 600) {
    this.pos = new Float32Array(max * 3); this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3); this.alpha = new Float32Array(max); this.size = new Float32Array(max);
    this.age = new Float32Array(max); this.life = new Float32Array(max); this.a0 = new Float32Array(max); this.s0 = new Float32Array(max); this.s1 = new Float32Array(max);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false, toneMapped: false,
      uniforms: { uScale: { value: 500 } },
      vertexShader: `#include <common>
        #include <logdepthbuf_pars_vertex>
        attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
        varying float vAlpha; varying vec3 vColor; uniform float uScale;
        void main() {
          vAlpha = aAlpha; vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aAlpha > 0.0 ? aSize * uScale / max(0.1, -mv.z) : 0.0;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `#include <common>
        #include <logdepthbuf_pars_fragment>
        varying float vAlpha; varying vec3 vColor;
        void main() {
          #include <logdepthbuf_fragment>
          float d = length(gl_PointCoord - 0.5);
          float a = vAlpha * smoothstep(0.5, 0.1, d);
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor, a);
        }`,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }
  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, gravel: boolean) {
    const k = this.next; this.next = (this.next + 1) % this.max;
    this.pos[k * 3] = x; this.pos[k * 3 + 1] = y; this.pos[k * 3 + 2] = z;
    this.vel[k * 3] = vx; this.vel[k * 3 + 1] = vy; this.vel[k * 3 + 2] = vz;
    const shade = 0.88 + Math.random() * 0.2;
    const c = gravel ? COLOR_GRAVEL : COLOR_GRASS;
    this.col[k * 3] = c[0] * shade; this.col[k * 3 + 1] = c[1] * shade; this.col[k * 3 + 2] = c[2] * shade;
    this.age[k] = 0; this.life[k] = (gravel ? 1.0 : 0.8) + Math.random() * 0.7;
    this.a0[k] = gravel ? 0.42 : 0.26; this.s0[k] = 0.5; this.s1[k] = (gravel ? 2.8 : 2.0) * (0.8 + Math.random() * 0.4);
  }
  update(dt: number, car: Vehicle, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer) {
    this.mat.uniforms.uScale.value = (renderer.domElement.height * 0.5) / Math.tan((camera.fov * Math.PI) / 360);
    if (dt <= 0) return;
    const v = car.vel, speed = Math.hypot(v.x, v.z);
    let spawned = false;
    for (let wi = 0; wi < car.wheels.length; wi++) {
      const w = car.wheels[wi];
      const off = w.grounded && (w.surf === S_GRASS || w.surf === S_GRAVEL) && speed > 4;
      if (!off) { this.carry[wi] = 0; continue; }
      const gravel = w.surf === S_GRAVEL;
      this.carry[wi] += (gravel ? 60 : 32) * clamp(speed / 25, 0.3, 1.6) * dt;
      while (this.carry[wi] >= 1) {
        this.carry[wi] -= 1; spawned = true;
        this.spawn(w.contact.x + rnd() * 0.4, w.contact.y + 0.05, w.contact.z + rnd() * 0.4,
          v.x * 0.3 + rnd() * 3, (gravel ? 1.4 : 0.9) + Math.random() * 1.2, v.z * 0.3 + rnd() * 3, gravel);
      }
    }
    const root = car.mesh.root;
    if (this.boxOf !== car.mesh.cockpit) { bodyBox(root, this.box); this.boxOf = car.mesh.cockpit; }
    _qi.copy(root.quaternion).invert();
    const drag = Math.exp(-1.6 * dt);
    let alive = false;
    for (let k = 0; k < this.max; k++) {
      if (this.age[k] >= this.life[k]) { this.alpha[k] = 0; continue; }
      alive = true;
      this.age[k] += dt;
      const t = Math.min(1, this.age[k] / this.life[k]);
      this.vel[k * 3 + 1] -= 1.5 * dt;
      for (let a = 0; a < 3; a++) { this.vel[k * 3 + a] *= drag; this.pos[k * 3 + a] += this.vel[k * 3 + a] * dt; }
      if (this.pos[k * 3 + 1] < 0.02) { this.pos[k * 3 + 1] = 0.02; this.vel[k * 3 + 1] = 0; }
      this.alpha[k] = this.a0[k] * Math.min(1, t * 8) * (1 - t) * (1 - t * 0.3);
      this.size[k] = lerp(this.s0[k], this.s1[k], Math.sqrt(t));
      // round the body, never through it
      _p.set(this.pos[k * 3], this.pos[k * 3 + 1], this.pos[k * 3 + 2]).sub(root.position).applyQuaternion(_qi);
      if (keepOut(_p, this.box, BODY_MARGIN * this.size[k])) {
        _p.applyQuaternion(root.quaternion).add(root.position);
        this.pos[k * 3] = _p.x; this.pos[k * 3 + 2] = _p.z;
      }
    }
    // Upload to the GPU only while there is dust (and once more as the last of it fades); colours only change on spawn.
    if (alive || this.wasAlive) {
      const a = this.geo.attributes;
      a.position.needsUpdate = a.aAlpha.needsUpdate = a.aSize.needsUpdate = true;
      if (spawned) a.aColor.needsUpdate = true;
    }
    this.wasAlive = alive;
  }
}
