import * as THREE from 'three';
import { poseCockpit, type CarMesh, type Cockpit } from './carMeshes';
import type { CarInfo } from './cars';
import type { MapDot } from './minimap';
import type { Multiplayer } from './multiplayer';
import { CAR_REASON, emptySample, STATE_FLAG, type RemoteSample } from './net';
import { compoundChip } from './raceHud';
import type { SprayCar } from './spray';

// ============================================================================
// Other players' cars, drawn: each a body of its car (the car spec's own mesh builder, as the player's car), posed
// every frame from its RemoteCar sampled at the time the player's car is drawn at. Wheels steer and roll from the
// state, the cockpit wheel turns, the brake light follows the brake. No physics: Multiplayer has the proxy bodies.
// A car that is not collidable (its owner's noCollide or pause, gone stale, or ours not collidable) is drawn
// translucent; a stale one fades out. A name tag over each car (DOM, in `labels`) and a dot for the minimap.
// ============================================================================
const GHOST_OPACITY = 0.38;
const LABEL_FAR = 350;                 // m: tags fade out towards this distance
// Player colours (name tags, minimap dots, the board), by player id.
const COLORS = ['#4fc3f7', '#ffd23f', '#3ddc84', '#ff7ab6', '#b46cff', '#ff9f43', '#7bed9f', '#f8f9fa'];
export const playerColor = (id: number) => COLORS[(id - 1 + COLORS.length) % COLORS.length];

export interface RemoteStatus { shown: boolean; ghost: boolean; paused: boolean; stale: boolean }

interface View {
  spec: CarInfo; mesh: CarMesh; cockpit: Cockpit | null;
  base: Map<THREE.Material, { transparent: boolean; opacity: number; depthWrite: boolean }>;
  ghost: boolean | null; opacity: number; spin: number;
  label: HTMLElement; labelText: string;
  readonly sample: RemoteSample;
  readonly spray: SprayCar & { vel: { x: number; y: number; z: number } };
}

const _v = new THREE.Vector3(), _fwd = new THREE.Vector3();

export class RemoteCars {
  readonly dots: MapDot[] = [];
  readonly drawn: SprayCar[] = [];   // the cars drawn this frame, as spray sources (weather.ts)
  readonly status = new Map<number, RemoteStatus>();
  private readonly views = new Map<number, View>();

  constructor(private readonly scene: THREE.Scene, private readonly labels: HTMLElement) {}

  // Every frame. now: the local time the player's car is drawn at; showLabels: the HUD is up.
  update(mp: Multiplayer, now: number, camera: THREE.PerspectiveCamera, dt: number, showLabels: boolean) {
    for (const [id, v] of this.views) {
      const p = mp.players.get(id);
      if (!p || p.spec?.id !== v.spec.id) this.remove(id);
    }
    this.dots.length = 0; this.drawn.length = 0;
    this.status.clear();
    const w = innerWidth, h = innerHeight;
    for (const p of mp.players.values()) {
      if (!p.spec) continue;
      let v = this.views.get(p.id);
      if (!v) this.views.set(p.id, v = this.build(p.spec));
      const s = mp.sampleAt(p.id, now, v.sample);
      const stale = !s || s.alpha < 1, paused = !!s && (s.flags & STATE_FLAG.paused) !== 0;
      const ghost = !s || !s.collidable || paused || mp.noCollide;
      this.status.set(p.id, { shown: !!s && s.alpha > 0, ghost, paused, stale });
      if (!s || s.alpha <= 0) { v.mesh.root.visible = false; v.label.hidden = true; continue; }
      if (v.mesh.cockpit !== v.cockpit) this.adopt(v);
      this.look(v, ghost, ghost ? GHOST_OPACITY * s.alpha : s.alpha);
      this.pose(v, s, dt);
      v.spray.root = v.mesh.root; v.spray.vel.x = s.vx; v.spray.vel.y = s.vy; v.spray.vel.z = s.vz;
      this.drawn.push(v.spray);
      this.dots.push({ x: s.x, z: s.z, color: playerColor(p.id), ghost });
      this.tag(v, p.info.name, s.compound, s.reason === CAR_REASON.pits, p.id, camera, w, h, showLabels);
    }
  }

  dispose() { for (const id of [...this.views.keys()]) this.remove(id); }

  // ------------------------------------------------------------------------
  private build(spec: CarInfo): View {
    const mesh = spec.mesh(spec);
    mesh.root.name = 'remote';
    this.scene.add(mesh.root);
    const label = document.createElement('div');
    label.className = 'nametag';
    label.hidden = true;
    this.labels.append(label);
    const v: View = { spec, mesh, cockpit: null, base: new Map(), ghost: null, opacity: -1, spin: 0, label, labelText: '', sample: emptySample(),
      spray: { root: mesh.root, spec, vel: { x: 0, y: 0, z: 0 } } };
    this.adopt(v);
    return v;
  }

  // Own copies of every material not yet copied (the originals may be a loaded model's, shared with every car built
  // from it: never changed), so this car alone can turn translucent. Again after a model is swapped in.
  private adopt(v: View) {
    const m = v.mesh, copies = new Map<THREE.Material, THREE.Material>(), used = new Set<THREE.Material>();
    v.cockpit = m.cockpit;
    if (m.cockpit.screen) m.cockpit.screen.mesh.visible = false;   // no live instruments in another player's car
    const own = (src: THREE.Material) => {
      let c = v.base.has(src) ? src : copies.get(src);
      if (!c) {
        c = src.clone(); c.userData = {};   // (so the car's dispose frees it)
        v.base.set(c, { transparent: c.transparent, opacity: c.opacity, depthWrite: c.depthWrite });
        copies.set(src, c);
        if (!src.userData.shared) src.dispose();
      }
      used.add(c);
      return c;
    };
    m.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.material = Array.isArray(o.material) ? o.material.map(own) : own(o.material as THREE.Material);
    });
    for (const mat of [...v.base.keys()]) if (!used.has(mat)) v.base.delete(mat);   // went with the swapped-out body
    v.ghost = null; v.opacity = -1;
  }

  private look(v: View, ghost: boolean, opacity: number) {
    if (ghost === v.ghost && Math.abs(opacity - v.opacity) < 0.01) return;
    const changed = ghost !== v.ghost;
    v.ghost = ghost; v.opacity = opacity;
    for (const [mat, b] of v.base) {
      const transparent = ghost || opacity < 0.999 || b.transparent;
      if (mat.transparent !== transparent) { mat.transparent = transparent; mat.needsUpdate = true; }
      mat.opacity = transparent && (ghost || opacity < 0.999) ? b.opacity * opacity : b.opacity;
      mat.depthWrite = ghost ? false : b.depthWrite;
    }
    if (changed) v.mesh.root.traverse((o) => { if (o instanceof THREE.Mesh && o.name === 'body') o.castShadow = !ghost; });
  }

  private pose(v: View, s: RemoteSample, dt: number) {
    const m = v.mesh, sp = v.spec;
    m.root.visible = true;
    m.root.position.set(s.x, s.y, s.z);
    m.root.quaternion.set(s.qx, s.qy, s.qz, s.qw);
    const fwd = _fwd.set(0, 0, 1).applyQuaternion(m.root.quaternion);
    const speed = s.vx * fwd.x + s.vy * fwd.y + s.vz * fwd.z;
    v.spin = (v.spin + (speed / sp.wheelRadius) * dt) % (2 * Math.PI);
    for (let k = 0; k < m.wheels.length; k++) {
      const wh = m.wheels[k], front = k < 2;
      // where the wheel sits with the car at rest on flat ground (the suspension is not sent)
      wh.pivot.position.set(k % 2 === 0 ? sp.trackHalf : -sp.trackHalf, sp.wheelRadius - sp.comHeight, front ? sp.zFront : sp.zRear);
      wh.pivot.rotation.y = front ? s.steer : 0;
      wh.spinner.rotation.x = v.spin;
    }
    poseCockpit(m.cockpit, s.steer);
    m.brakeLight.material.emissiveIntensity = s.brake > 0.1 ? 3 : 0.4;
  }

  // The tag: the name, then the tyres on (a race weekend) and PIT while in the pit lane.
  private tag(v: View, name: string, compound: number, pits: boolean, id: number, camera: THREE.PerspectiveCamera, w: number, h: number, show: boolean) {
    const p = _v.copy(v.mesh.root.position);
    p.y += 1.5;
    const d = camera.position.distanceTo(p);
    p.project(camera);
    const on = show && p.z > -1 && p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1 && d < LABEL_FAR && d > 2;
    v.label.hidden = !on;
    if (!on) return;
    const key = `${name}|${compound}|${pits}`;
    if (v.labelText !== key) {
      v.labelText = key; v.label.textContent = name;
      if (compound || pits) v.label.insertAdjacentHTML('beforeend', ` ${compoundChip(compound)}${pits ? '<b class="tpit">PIT</b>' : ''}`);
      v.label.style.setProperty('--c', playerColor(id));
    }
    const x = (p.x * 0.5 + 0.5) * w, y = (-p.y * 0.5 + 0.5) * h;
    v.label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    v.label.style.opacity = String(Math.max(0.25, Math.min(1, 1.2 - d / LABEL_FAR)) * (v.ghost ? 0.7 : 1));
  }

  private remove(id: number) {
    const v = this.views.get(id);
    if (!v) return;
    this.views.delete(id);
    this.scene.remove(v.mesh.root);
    v.mesh.dispose();
    v.label.remove();
  }
}
