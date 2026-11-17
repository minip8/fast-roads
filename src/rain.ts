import * as THREE from 'three';
import { clamp } from './util';

// ============================================================================
// Rain (built by weather.ts only while it rains): falling streaks around the camera, and drops on the lens or visor
// in the Onboard and Driver cameras.
//
// Streaks: one instanced quad per drop. Each drop has a fixed spot in a cube of side BOX that tiles all space and
// falls with the rain; the vertex shader wraps it into the cube round the camera, so the drops are fixed in the
// world (they stream past at speed) and never run out. A drop is drawn as the line it sweeps relative to the camera
// over a short exposure, so it is a short vertical streak at a standstill and a long one flying at the camera at
// 300 km/h. Drops fade out well inside the cube (a sphere), so its faces are never seen, and fade in from 0.5 m (no
// drop fills the screen). At least about a pixel wide, a far drop fades rather than shrinks (no shimmering). Drops
// inside the player's car body (its box) are not drawn: no rain inside a closed cockpit.
// ============================================================================
export const BOX = 32;                 // m: side of the cube of drops round the camera
const FALL = new THREE.Vector3(1.3, -8.5, 0.7);   // m/s: the rain's fall (a little wind)
const EXPOSURE = 1 / 70;               // s: the streak a drop sweeps (relative to the camera)
const MAX_LEN = 2.6;                   // m: longest streak
const WIDTH = 0.0075;                  // m

const _m = new THREE.Matrix4();

export class RainStreaks {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private readonly off = [new THREE.Vector3(), new THREE.Vector3()];   // the two speed groups' fall so far, wrapped

  constructor(readonly max: number) {
    const geo = new THREE.InstancedBufferGeometry();
    // corners: x across the streak (-1..1), y along it (0 at the drop, 1 at the end of its sweep)
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0]), 3));
    geo.setIndex([0, 2, 1, 1, 2, 3]);
    const seed = new Float32Array(max * 4);
    for (let i = 0; i < seed.length; i++) seed[i] = Math.random();
    geo.setAttribute('seed', new THREE.InstancedBufferAttribute(seed, 4));
    geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
      uniforms: {
        uCenter: { value: new THREE.Vector3() }, uOff1: { value: this.off[0] }, uOff2: { value: this.off[1] },
        uFall: { value: FALL.clone() }, uCamVel: { value: new THREE.Vector3() },
        uBox: { value: BOX }, uPx: { value: 0.002 }, uColor: { value: new THREE.Color() }, uAlpha: { value: 0.5 },
        uCarInv: { value: new THREE.Matrix4() }, uCarMin: { value: new THREE.Vector3(1, 1, 1) }, uCarMax: { value: new THREE.Vector3(-1, -1, -1) },
      },
      vertexShader: `#include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec4 seed;
        uniform vec3 uCenter, uOff1, uOff2, uFall, uCamVel, uCarMin, uCarMax; uniform mat4 uCarInv;
        uniform float uBox, uPx, uAlpha;
        varying float vAlpha; varying vec2 vUv;
        void main() {
          float slow = step(0.5, seed.w);                    // two speed groups: 1 and 0.8 of the fall
          vec3 fall = uFall * (1. - 0.2 * slow);
          vec3 p = seed.xyz * uBox + mix(uOff1, uOff2, slow);
          p = uCenter + mod(p - uCenter, uBox) - 0.5 * uBox;   // the copy of this drop in the cube round the camera
          vec3 rel = fall - uCamVel;                         // its velocity seen from the camera
          float speed = max(length(rel), 1e-3), len = min(speed * ${EXPOSURE.toFixed(5)}, ${MAX_LEN.toFixed(2)});
          vec3 tail = p - rel / speed * len;
          vec3 hv = (modelViewMatrix * vec4(p, 1.)).xyz, tv = (modelViewMatrix * vec4(tail, 1.)).xyz;
          vec3 v = mix(hv, tv, position.y);
          vec3 side = cross(tv - hv, v);
          float sl = length(side);
          side = sl > 1e-7 ? side / sl : vec3(1., 0., 0.);
          float w = max(${WIDTH.toFixed(4)}, 1.3 * uPx * max(-v.z, 0.05));   // at least about a pixel wide
          v += side * position.x * 0.5 * w;
          float dist = length(p - uCenter);
          // a streak seen end-on (a drop straight ahead at speed) is short on screen: faded, or the drops ahead pile
          // up into a blot round the point the car heads for
          float sinA = length(cross(normalize(tv - hv + vec3(0., 1e-5, 0.)), normalize(hv)));
          vAlpha = uAlpha * smoothstep(0.08, 0.6, sinA) * smoothstep(0.5, 1.5, dist) * (1. - smoothstep(uBox * 0.28, uBox * 0.46, dist))
            * ${WIDTH.toFixed(4)} / w * clamp(0.45 / len, 0.35, 1.);
          vec3 lc = (uCarInv * vec4(p, 1.)).xyz;
          if (all(greaterThan(lc, uCarMin)) && all(lessThan(lc, uCarMax))) vAlpha = 0.;
          vUv = position.xy;
          gl_Position = vAlpha > 0.003 ? projectionMatrix * vec4(v, 1.) : vec4(0., 0., -2., 1.);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `#include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uColor; varying float vAlpha; varying vec2 vUv;
        void main() {
          #include <logdepthbuf_fragment>
          float a = vAlpha * (1. - vUv.x * vUv.x) * smoothstep(0., 0.25, vUv.y) * smoothstep(1., 0.6, vUv.y);
          gl_FragColor = vec4(uColor, a);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'rain';
  }

  // Every frame. dt: frame time (0 while paused: the rain stops too); rain 0..1; camVel: the camera's velocity (the
  // car's); color: the light the drops catch; car: the player's body and its box in its own frame (drops inside it
  // are not drawn), or null.
  update(dt: number, rain: number, camera: THREE.PerspectiveCamera, heightPx: number, camVel: THREE.Vector3, color: THREE.Color,
    car: { root: THREE.Object3D; box: THREE.Box3 } | null) {
    const u = this.mesh.material.uniforms;
    for (let k = 0; k < 2; k++) {
      const o = this.off[k].addScaledVector(FALL, dt * (k ? 0.8 : 1));
      o.set(((o.x % BOX) + BOX) % BOX, ((o.y % BOX) + BOX) % BOX, ((o.z % BOX) + BOX) % BOX);
    }
    u.uCenter.value.copy(camera.position);
    (u.uCamVel.value as THREE.Vector3).copy(camVel).clampLength(0, 120);
    u.uPx.value = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, heightPx);
    u.uColor.value.copy(color);
    u.uAlpha.value = 0.75 + 0.45 * rain;
    if (car) {
      (u.uCarInv.value as THREE.Matrix4).copy(_m.copy(car.root.matrixWorld).invert());
      u.uCarMin.value.copy(car.box.min); u.uCarMax.value.copy(car.box.max);
    } else { u.uCarMin.value.set(1, 1, 1); u.uCarMax.value.set(-1, -1, -1); }
    this.mesh.geometry.instanceCount = Math.round(this.max * clamp(rain, 0, 1) ** 0.8);
    this.mesh.visible = this.mesh.geometry.instanceCount > 0;
  }

  dispose() { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

// ============================================================================
// Drops on the lens (Onboard camera) or the visor (Driver camera): a few dozen translucent beads drawn over the
// view in screen space, on layer 1 (which only the main camera sees: not the mirror). There is no refraction (that
// would need a copy of the frame): each bead is lit like a lens of water, the sky's light at its bottom and the
// ground's darker tone at its top, with a bright glint. At a standstill they sit and slowly slide down; at speed
// the airflow drags them out towards the top and edges as streaks, and more arrive.
// ============================================================================
export const LENS_LAYER = 1;
const LENS_MAX = 48;

export class LensDrops {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private readonly drop: Float32Array<ArrayBuffer>;   // x, y (screen: y -1..1, x scaled by the aspect), radius, alpha
  private readonly dir: Float32Array<ArrayBuffer>;    // the streak's direction (x, y) and stretch
  private readonly age = new Float32Array(LENS_MAX); private readonly life = new Float32Array(LENS_MAX);
  private readonly r0 = new Float32Array(LENS_MAX);
  private carry = 0; private next = 0;

  constructor() {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), 3));
    geo.setIndex([0, 1, 2, 2, 1, 3]);
    this.drop = new Float32Array(LENS_MAX * 4); this.dir = new Float32Array(LENS_MAX * 3);
    geo.setAttribute('iDrop', new THREE.InstancedBufferAttribute(this.drop, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('iDir', new THREE.InstancedBufferAttribute(this.dir, 3).setUsage(THREE.DynamicDrawUsage));
    geo.instanceCount = LENS_MAX;
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthTest: false, depthWrite: false, fog: false, side: THREE.DoubleSide,
      uniforms: { uAspect: { value: 1 }, uSky: { value: new THREE.Color() }, uGround: { value: new THREE.Color() } },
      vertexShader: `attribute vec4 iDrop; attribute vec3 iDir; uniform float uAspect; varying vec2 vP; varying float vA;
        void main() {
          vec2 d = iDir.xy, n = vec2(d.y, -d.x);   // (n, d) right-handed: the quad stays front-facing
          float r = iDrop.z;
          // the bead, stretched back along its direction of travel into a streak
          vec2 p = iDrop.xy + n * position.x * r + d * (position.y < 0. ? position.y * r * iDir.z : position.y * r);
          vP = vec2(position.x, position.y);
          vA = iDrop.w;
          gl_Position = iDrop.w > 0.001 ? vec4(p.x / uAspect, p.y, 0., 1.) : vec4(0., 0., -2., 1.);
        }`,
      fragmentShader: `uniform vec3 uSky, uGround; varying vec2 vP; varying float vA;
        void main() {
          float d = length(vP);
          if (d > 1.) discard;
          float edge = smoothstep(1., 0.82, d);
          // lit like a lens of water: the sky's light at the bottom, the ground's tone at the top, a dark rim, a glint
          vec3 c = mix(uSky * 1.15, uGround, smoothstep(-0.7, 0.8, vP.y));
          c *= mix(0.55, 1., smoothstep(0.98, 0.6, d));
          float glint = smoothstep(0.32, 0.05, length(vP - vec2(-0.3, 0.42)));
          c += glint * 0.8;
          gl_FragColor = vec4(c, vA * edge * (0.38 + 0.35 * glint + 0.25 * (1. - smoothstep(0.6, 1., d))));
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1000;
    this.mesh.layers.set(LENS_LAYER);
    this.mesh.name = 'lensDrops';
  }

  // Every frame. shown: a camera with a lens (else the drops dry off quickly); speed: the car's, m/s.
  update(dt: number, rain: number, shown: boolean, speed: number, aspect: number, sky: THREE.Color, ground: THREE.Color) {
    const u = this.mesh.material.uniforms;
    u.uAspect.value = aspect; u.uSky.value.copy(sky); u.uGround.value.copy(ground);
    if (dt <= 0) return;
    const k = clamp(speed / 45, 0, 1.6);
    // new drops
    this.carry += shown ? rain * (5 + 9 * k) * dt : 0;
    while (this.carry >= 1) {
      this.carry -= 1;
      const i = this.next; this.next = (this.next + 1) % LENS_MAX;
      this.drop[i * 4] = (Math.random() * 2 - 1) * aspect; this.drop[i * 4 + 1] = Math.random() * 2 - 1;
      this.r0[i] = 0.008 + Math.random() ** 2 * 0.022;
      this.age[i] = 0; this.life[i] = 1.2 + Math.random() * 3;
    }
    const fade = shown ? 1 : 6;   // leaving the camera: the drops go in a moment
    let any = false;
    for (let i = 0; i < LENS_MAX; i++) {
      if (this.age[i] >= this.life[i]) { this.drop[i * 4 + 3] = 0; continue; }
      any = true;
      this.age[i] += dt * fade;
      const x = this.drop[i * 4], y = this.drop[i * 4 + 1];
      // airflow drags them up and out from the centre; at a standstill they slide down
      const vx = x * 0.55 * k, vy = 0.55 * k + (0.35 * k - 0.05) * Math.abs(x) * 0.3 - 0.04 * (1 - Math.min(1, k));
      this.drop[i * 4] = x + vx * dt; this.drop[i * 4 + 1] = y + vy * dt;
      const v = Math.hypot(vx, vy), t = this.age[i] / this.life[i];
      this.drop[i * 4 + 2] = this.r0[i] * (1 - 0.3 * Math.min(1, v));
      this.drop[i * 4 + 3] = Math.min(1, this.age[i] * 12) * (1 - t * t);
      if (v > 1e-4) { this.dir[i * 3] = vx / v; this.dir[i * 3 + 1] = vy / v; } else { this.dir[i * 3] = 0; this.dir[i * 3 + 1] = -1; }
      this.dir[i * 3 + 2] = 1 + Math.min(9, v * 14);
      if (Math.abs(this.drop[i * 4 + 1]) > 1.1 || Math.abs(this.drop[i * 4]) > aspect + 0.1) this.age[i] = this.life[i];
    }
    const a = this.mesh.geometry.attributes;
    a.iDrop.needsUpdate = a.iDir.needsUpdate = true;
    this.mesh.visible = any;
  }

  dispose() { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}
