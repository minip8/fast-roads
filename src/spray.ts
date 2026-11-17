import * as THREE from 'three';
import type { CarInfo } from './cars';
import { S_GRASS, S_GRAVEL } from './config';
import { clamp, lerp } from './util';
import type { VehicleWheel } from './vehicle';

// ============================================================================
// Spray thrown up by cars on a wet track (built by weather.ts only while the track is wet): soft camera-facing
// puffs from each tyre, more from the rears, and a plume off the back of the car, by speed and how much water is
// on the road. Thrown back off the tyres, the mist loses its speed quickly and hangs in the air behind the car, so a
// car following through it sees less (most of the cost: overlapping translucent puffs, so the counts are capped and
// the Weather effects setting lowers them). Any car can throw it: the player's and the session's extra cars (their
// wheels' contact points, none off the asphalt and kerbs) and other players' cars (from the body's pose).
// One instanced quad per puff; the puffs fade out towards the road (no hard line where a quad meets it), close to
// the camera (none fills the screen) and with the fog.
// ============================================================================
const rnd = () => Math.random() - 0.5;
const _fwd = new THREE.Vector3(), _left = new THREE.Vector3(), _p = new THREE.Vector3();

// A car to throw spray from: its body (the root's pose), its spec (axles, track) and its velocity; with wheels, their
// contact points and surfaces.
export interface SprayCar {
  root: THREE.Object3D; spec: CarInfo;
  vel: { readonly x: number; readonly y: number; readonly z: number };
  wheels?: readonly VehicleWheel[];
}

export class Spray {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private readonly pos: Float32Array<ArrayBuffer>;    // x, y, z, ground height
  private readonly look: Float32Array<ArrayBuffer>;   // size, alpha
  private readonly vel: Float32Array<ArrayBuffer>;
  private readonly age: Float32Array<ArrayBuffer>; private readonly life: Float32Array<ArrayBuffer>;
  private readonly s0: Float32Array<ArrayBuffer>; private readonly s1: Float32Array<ArrayBuffer>; private readonly a0: Float32Array<ArrayBuffer>;
  private next = 0;
  private readonly carry = new WeakMap<object, number[]>();   // fractional puffs owed, per car and source
  private live = false;

  constructor(readonly max: number) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), 3));
    geo.setIndex([0, 1, 2, 2, 1, 3]);
    this.pos = new Float32Array(max * 4); this.look = new Float32Array(max * 2); this.vel = new Float32Array(max * 3);
    this.age = new Float32Array(max); this.life = new Float32Array(max);
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max); this.a0 = new Float32Array(max);
    geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(this.pos, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('iLook', new THREE.InstancedBufferAttribute(this.look, 2).setUsage(THREE.DynamicDrawUsage));
    geo.instanceCount = max;
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
      uniforms: {
        uRight: { value: new THREE.Vector3(1, 0, 0) }, uUp: { value: new THREE.Vector3(0, 1, 0) }, uCam: { value: new THREE.Vector3() },
        uColor: { value: new THREE.Color() }, uFog: { value: 0.0004 },
      },
      vertexShader: `#include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec4 iPos; attribute vec2 iLook;
        uniform vec3 uRight, uUp, uCam; uniform float uFog;
        varying vec2 vP; varying float vA; varying float vY; varying float vGround; varying float vSize;
        void main() {
          vec3 wp = iPos.xyz + (uRight * position.x + uUp * position.y) * iLook.x;
          float dist = length(iPos.xyz - uCam), f = uFog * dist;
          vA = iLook.y * smoothstep(0.6, 3.0, dist) * exp(-f * f);
          vP = position.xy; vY = wp.y; vGround = iPos.w; vSize = iLook.x;
          gl_Position = vA > 0.002 ? projectionMatrix * modelViewMatrix * vec4(wp, 1.) : vec4(0., 0., -2., 1.);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `#include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uColor; varying vec2 vP; varying float vA; varying float vY; varying float vGround; varying float vSize;
        void main() {
          #include <logdepthbuf_fragment>
          float d = dot(vP, vP);
          if (d > 1.) discard;
          // a soft puff, a little lumpy, fading out towards the road
          float lump = 0.85 + 0.15 * sin(vP.x * 5.1 + vP.y * 3.7) * sin(vP.y * 4.3 - vP.x * 2.9);
          float a = vA * (1. - d) * (1. - d) * lump * smoothstep(vGround, vGround + 0.45 * vSize, vY);
          if (a < 0.003) discard;
          gl_FragColor = vec4(uColor, a);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'spray';
  }

  // Throw spray from one car this frame. amount: the weather's spray share (0..1, by the water on the road); scale:
  // the Weather effects setting's share of puffs; alpha: a factor on their opacity.
  emit(car: SprayCar, dt: number, amount: number, scale: number, alpha = 1) {
    const v = car.vel, speed = Math.hypot(v.x, v.z);
    const k = amount * clamp((speed - 6) / 55, 0, 1.5) ** 1.3;   // grows with speed, none at a crawl
    let owed = this.carry.get(car.root);
    if (!owed) this.carry.set(car.root, owed = [0, 0, 0, 0, 0]);
    if (k <= 0 || dt <= 0) { owed.fill(0); return; }
    const sp = car.spec, q = car.root.quaternion, root = car.root.position;
    const fwd = _fwd.set(0, 0, 1).applyQuaternion(q), left = _left.set(1, 0, 0).applyQuaternion(q);
    const groundY = root.y - sp.comHeight;
    const strength = clamp(speed / 60, 0.2, 1.4);
    for (let w = 0; w < 5; w++) {
      // sources 0-3: the tyres (FL, FR, RL, RR); 4: the plume off the back of the car
      const rear = w >= 2;
      let x: number, y: number, z: number;
      if (w < 4) {
        const wh = car.wheels?.[w];
        if (wh && (!wh.grounded || wh.surf === S_GRASS || wh.surf === S_GRAVEL)) { owed[w] = 0; continue; }
        if (wh) { x = wh.contact.x; y = wh.contact.y; z = wh.contact.z; }
        else {
          _p.copy(root).addScaledVector(left, w % 2 === 0 ? sp.trackHalf : -sp.trackHalf).addScaledVector(fwd, rear ? sp.zRear : sp.zFront);
          x = _p.x; y = groundY; z = _p.z;
        }
        // from the back of the tyre
        x -= fwd.x * sp.wheelRadius * 0.8; z -= fwd.z * sp.wheelRadius * 0.8;
      } else {
        _p.copy(root).addScaledVector(fwd, sp.zRear - sp.wheelRadius * 1.6);
        x = _p.x; y = groundY; z = _p.z;
      }
      owed[w] += (w === 4 ? 36 : rear ? 55 : 18) * k * scale * dt;
      while (owed[w] >= 1) {
        owed[w] -= 1;
        const i = this.next; this.next = (this.next + 1) % this.max;
        const j = i * 4, side = w === 4 ? rnd() * 2 : (w % 2 === 0 ? 1 : -1) * (0.3 + Math.random() * 0.7);
        const up = (w === 4 ? 0.9 : 0.6) + Math.random() * 0.9 * strength;
        // thrown back off the tyre at some of the car's speed, up and out
        const keep = 0.55 + Math.random() * 0.3, out = side * (0.6 + 1.5 * strength);
        const jx = rnd() * 0.3, jz = rnd() * 0.3;
        this.pos[j] = x + jx; this.pos[j + 1] = y + 0.15 + Math.random() * 0.25; this.pos[j + 2] = z + jz; this.pos[j + 3] = y;
        this.vel[i * 3] = v.x * keep + left.x * out + rnd() * 1.2;
        this.vel[i * 3 + 1] = up;
        this.vel[i * 3 + 2] = v.z * keep + left.z * out + rnd() * 1.2;
        this.age[i] = 0; this.life[i] = (w === 4 ? 1.0 : 0.7) + Math.random() * 0.9;
        this.s0[i] = (w === 4 ? 0.9 : 0.6) * (0.8 + 0.4 * strength);
        this.s1[i] = (w === 4 ? 2.6 : 1.7) * (0.7 + 0.6 * Math.random()) * (0.75 + 0.35 * strength);
        this.a0[i] = (w === 4 ? 0.17 : 0.24) * (0.6 + 0.4 * amount) * alpha;
        this.live = true;
      }
    }
  }

  // Every frame, after emit: move the puffs and upload. dt 0: paused.
  update(dt: number, camera: THREE.Camera, color: THREE.Color, fogDensity: number) {
    const u = this.mesh.material.uniforms;
    camera.matrixWorld.extractBasis(u.uRight.value, u.uUp.value, _p);
    u.uCam.value.copy(camera.position); u.uColor.value.copy(color); u.uFog.value = fogDensity;
    if (dt <= 0 || !this.live) { this.mesh.visible = this.live; return; }
    const drag = Math.exp(-2.6 * dt);
    let alive = false;
    for (let i = 0; i < this.max; i++) {
      if (this.age[i] >= this.life[i]) { this.look[i * 2 + 1] = 0; continue; }
      alive = true;
      this.age[i] += dt;
      const t = Math.min(1, this.age[i] / this.life[i]), j = i * 4;
      this.vel[i * 3 + 1] -= 1.6 * dt;
      for (let a = 0; a < 3; a++) { this.vel[i * 3 + a] *= drag; this.pos[j + a] += this.vel[i * 3 + a] * dt; }
      const size = lerp(this.s0[i], this.s1[i], Math.sqrt(t));
      if (this.pos[j + 1] < this.pos[j + 3] + 0.25 * size) { this.pos[j + 1] = this.pos[j + 3] + 0.25 * size; this.vel[i * 3 + 1] = Math.max(0, this.vel[i * 3 + 1]); }
      this.look[i * 2] = size;
      this.look[i * 2 + 1] = this.a0[i] * Math.min(1, t * 12) * (1 - t) * (1 - t);
    }
    const a = this.mesh.geometry.attributes;
    a.iPos.needsUpdate = a.iLook.needsUpdate = true;
    this.live = alive;
    this.mesh.visible = alive;
  }

  dispose() { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}
