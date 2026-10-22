import * as THREE from 'three';
import { S_GRASS, S_GRAVEL } from './config.js';
import { clamp, lerp } from './util.js';

// ============================================================================
// Dust kicked up by wheels on grass / gravel (purely visual)
// ============================================================================
export class Dust {
  constructor(scene, max = 600) {
    this.max = max; this.next = 0; this.carry = [0, 0, 0, 0];
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
  spawn(x, y, z, vx, vy, vz, gravel) {
    const k = this.next; this.next = (this.next + 1) % this.max;
    this.pos[k * 3] = x; this.pos[k * 3 + 1] = y; this.pos[k * 3 + 2] = z;
    this.vel[k * 3] = vx; this.vel[k * 3 + 1] = vy; this.vel[k * 3 + 2] = vz;
    const shade = 0.9 + Math.random() * 0.2;
    const c = gravel ? [0.80, 0.72, 0.56] : [0.56, 0.55, 0.38];
    this.col[k * 3] = c[0] * shade; this.col[k * 3 + 1] = c[1] * shade; this.col[k * 3 + 2] = c[2] * shade;
    this.age[k] = 0; this.life[k] = 0.7 + Math.random() * 0.6;
    this.a0[k] = gravel ? 0.26 : 0.18; this.s0[k] = 0.35; this.s1[k] = gravel ? 1.8 : 1.3;
  }
  update(dt, car, camera, renderer) {
    this.mat.uniforms.uScale.value = (renderer.domElement.height * 0.5) / Math.tan((camera.fov * Math.PI) / 360);
    if (dt <= 0) return;
    const v = car.vel, speed = Math.hypot(v.x, v.z);
    car.wheels.forEach((w, wi) => {
      const off = w.grounded && (w.surf === S_GRASS || w.surf === S_GRAVEL) && speed > 4;
      if (!off) { this.carry[wi] = 0; return; }
      const gravel = w.surf === S_GRAVEL;
      this.carry[wi] += (gravel ? 55 : 25) * clamp(speed / 25, 0.3, 1.5) * dt;
      while (this.carry[wi] >= 1) {
        this.carry[wi] -= 1;
        const r = () => Math.random() - 0.5;
        this.spawn(w.contact.x + r() * 0.4, w.contact.y + 0.05, w.contact.z + r() * 0.4,
          v.x * 0.3 + r() * 3, (gravel ? 1.4 : 0.9) + Math.random() * 1.2, v.z * 0.3 + r() * 3, gravel);
      }
    });
    const drag = Math.exp(-1.6 * dt);
    for (let k = 0; k < this.max; k++) {
      if (this.age[k] >= this.life[k]) { this.alpha[k] = 0; continue; }
      this.age[k] += dt;
      const t = Math.min(1, this.age[k] / this.life[k]);
      this.vel[k * 3 + 1] -= 1.5 * dt;
      for (let a = 0; a < 3; a++) { this.vel[k * 3 + a] *= drag; this.pos[k * 3 + a] += this.vel[k * 3 + a] * dt; }
      if (this.pos[k * 3 + 1] < 0.02) { this.pos[k * 3 + 1] = 0.02; this.vel[k * 3 + 1] = 0; }
      this.alpha[k] = this.a0[k] * (1 - t);
      this.size[k] = lerp(this.s0[k], this.s1[k], Math.sqrt(t));
    }
    for (const n of ['position', 'aColor', 'aAlpha', 'aSize']) this.geo.attributes[n].needsUpdate = true;
  }
}
