import * as THREE from 'three';
import { bodyBox } from './camera';
import { setCarEnvironment } from './carMeshes';
import { LENS_LAYER, LensDrops, RainStreaks } from './rain';
import { Spray, type SprayCar } from './spray';
import { applyBase, disposeEnvLamps, envLamps, fogForDisplay, LOOKS, type LightBase, type RGB } from './timeOfDay';
import { clamp, lerp } from './util';
import type { Vehicle } from './vehicle';

// ============================================================================
// Weather as the player sees and hears it, from two numbers that the game sets every frame (`set`):
//   rain      0..1  0 a dry sky, 1 a downpour: cloud, light, fog, falling rain, drops on the lens, the rain's sound
//   wetness   0..1  the track: 0 dry, about 0.3 damp, 1 standing water: the road's look, spray, wet tyre sound
// They are independent (the track stays wet for minutes after the rain stops). Visuals and sound only: the grip is
// the physics' business. `weatherLook` maps them to everything drawn (tested on its own).
//
// Nothing is built while both are 0, and the scene is then exactly the dry one: the first non-zero value builds what
// is needed (rain, spray, the wet road's material, overcast reflections), and when both are back at 0 every change
// is undone and everything built is freed. The shown values ease towards the set ones over a few seconds (the first
// `set` is taken at once), so a sudden change does not pop.
//
//   sky:    the sky shader's WEATHER define (scenery.ts buildSky) while overcast: grey cloud deck, horizon in the fog
//   light:  sun and its shadows fade behind the cloud, the hemisphere light turns grey; fog thickens and greys
//   road:   the road mesh (and the pit lane's) swaps to a wet copy of its material (darker, glossy, reflecting the sky; patchy when damp;
//           puddles with standing water); kerbs and lines glossier, grass, gravel and walls darker
//   reflections: the cars' and the wet road's environment map is the sky's again, made overcast (a few cached
//           levels, made as the weather crosses them)
//   rain.ts:  streaks round the camera, drops on the lens/visor (Onboard, Driver);  spray.ts: spray behind every car
//   weatherAudio.ts: rain and wet tyres, through the sound graph (EngineAudio.weather)
// The Weather effects setting (`quality`) scales the particles; the sky, light and road cost nothing extra.
//
// The weather works on the time of day (timeOfDay.ts): the stage's `light` is the dry base for the look shown (its
// fog, key light and sky light, the greys its cloud and rain turn to, whether cloud hides the key light: the sun, yes;
// the floodlights at night, no), read every frame; when it is dry again the base is put back as it is then.
// ============================================================================
export interface WeatherState { rain: number; wetness: number }
export type WeatherQuality = 'full' | 'reduced' | 'off';

// Particle budgets per Weather effects setting: rain streaks, spray puffs (and the share of them thrown), lens drops.
export const WEATHER_BUDGET: Record<WeatherQuality, { streaks: number; spray: number; sprayShare: number; lens: boolean }> = {
  full: { streaks: 9000, spray: 1800, sprayShare: 1, lens: true },
  reduced: { streaks: 3500, spray: 700, sprayShare: 0.5, lens: false },
  off: { streaks: 0, spray: 0, sprayShare: 0, lens: false },
};

export const FOG_DENSITY = 0.00042;   // the dry fog of the plain day (timeOfDay.ts LOOKS.clear)
const EASE = 4;                       // s: time constant of the shown values following the set ones
const SPRAY_FAR = 400;                // m: cars further from the camera throw no spray (the fog has them)
const ENV_LEVELS = 5;                 // overcast reflection maps, made as the weather reaches each
const ENV_SIZE = 128;
const OWN_SPRAY = 0.5;                // the player's own spray is fainter: the chase cameras sit in it, and the car must show

export interface WeatherLook {
  overcast: number;      // cloud cover 0..1 (sky, reflections)
  sun: number;           // share of the sun's light (and so of its shadows' depth)
  hemi: number;          // the sky light's intensity, a factor on the dry one
  fogDensity: number;    // FogExp2
  fog: [number, number, number];   // fog and horizon colour, display space
  mist: [number, number, number];  // the colour rain and spray are lit to, display space (the fog's, lighter under floodlights)
  wet: number;           // the road's wet look 0..1: darker, glossy
  puddles: number;       // standing water 0..1
  spray: number;         // water thrown up 0..1
  rain: number;          // falling rain 0..1
}
export const newLook = (): WeatherLook => ({ overcast: 0, sun: 1, hemi: 1, fogDensity: FOG_DENSITY, fog: [...LOOKS.clear.horizon], mist: [...LOOKS.clear.horizon], wet: 0, puddles: 0, spray: 0, rain: 0 });
// What weatherLook needs of the time of day (a LightBase; the plain day's by default).
export type WeatherBase = Pick<LightBase, 'fogDisplay' | 'fogDensity' | 'overcastFog' | 'rainFog' | 'mistLift'>;
const DAY: WeatherBase = { fogDisplay: LOOKS.clear.horizon, fogDensity: FOG_DENSITY, overcastFog: LOOKS.clear.overcastFog, rainFog: LOOKS.clear.rainFog, mistLift: 0 };
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// What rain and wetness look like. Light rain (0.3) already has a grey sky and no sun; heavier rain darkens and
// thickens the fog (a downpour leaves a few hundred metres). The road looks wet from damp on (patchily: weather.ts),
// spray comes in once there is a film of water, and puddles with standing water. The fog's colours are the time of
// day's (`base`): its dry horizon, and the greys of its cloud and rain.
export function weatherLook(rain: number, wetness: number, out: WeatherLook = newLook(), base: WeatherBase = DAY): WeatherLook {
  rain = clamp(rain, 0, 1); wetness = clamp(wetness, 0, 1);
  const o = 1 - (1 - clamp(rain / 0.4, 0, 1)) ** 2;
  out.overcast = o;
  out.sun = (1 - o) ** 2;
  out.hemi = 1 + 0.55 * o - 0.3 * rain;
  out.fogDensity = base.fogDensity + 0.0005 * o + 0.0024 * rain ** 1.5;
  const r = rain ** 1.2;
  for (let k = 0; k < 3; k++) {
    out.fog[k] = lerp(lerp(base.fogDisplay[k], base.overcastFog[k], o), base.rainFog[k], r);
    out.mist[k] = Math.min(1, out.fog[k] + base.mistLift);
  }
  out.wet = clamp(wetness / 0.45, 0, 1) ** 0.7;
  out.puddles = smooth(0.55, 1, wetness);
  out.spray = smooth(0.12, 0.8, wetness);
  out.rain = rain;
  return out;
}

// The dev flags: ?rain=0.7&wet=0.5 (each 0..1; bare ?rain is 1). ?rain alone wets the road to match (visuals only:
// the physics reads ?wet itself). null: neither given.
export function weatherFromUrl(params: URLSearchParams): WeatherState | null {
  const r = params.get('rain'), w = params.get('wet');
  if (r == null && w == null) return null;
  const num = (v: string) => (v === '' ? 1 : Number.isFinite(Number(v)) ? clamp(Number(v), 0, 1) : 0);
  const rain = r == null ? 0 : num(r);
  return { rain, wetness: w == null ? rain : num(w) };
}

// What the weather changes on the stage (stage.ts's Stage has it all; tests pass their own, without a renderer).
export interface WeatherStage {
  renderer: THREE.WebGLRenderer | null;
  light: LightBase;             // the time of day: the dry values the weather starts from and puts back
  scene: THREE.Scene; camera: THREE.PerspectiveCamera;
  sky: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  sun: THREE.DirectionalLight; hemi: THREE.HemisphereLight;
  env: THREE.Texture | null;    // the dry environment map (cars)
  surfaces: {
    road: THREE.Mesh; roadMat: THREE.MeshStandardMaterial; lineMat: THREE.MeshStandardMaterial; kerbMat: THREE.MeshStandardMaterial;
    laneRoads?: readonly THREE.Mesh[];   // the pit lane's road (pitLaneMesh.ts), in the road's material: wet with it
    gravelMat: THREE.MeshStandardMaterial; wallMat: THREE.MeshStandardMaterial; terrain: THREE.MeshStandardMaterial;
  };
}
// What update reads each frame: the camera mode (lens drops), the session's cars and other players' cars (spray).
export interface WeatherCamera { readonly mode: string; readonly lookBack: boolean }
export interface WeatherCars { readonly car: Vehicle; readonly others: readonly { readonly car: Vehicle }[] }
export interface WeatherRemote { readonly drawn: readonly SprayCar[] }

// Everything built while the weather is not dry, and the dry values it changed.
interface Built {
  base: { colors: Map<THREE.MeshStandardMaterial, THREE.Color>; rough: Map<THREE.MeshStandardMaterial, number> };
  wetRoad: THREE.MeshStandardMaterial; roadU: { uWet: { value: number }; uPuddle: { value: number }; uPuddleMap: { value: THREE.Texture } };
  wetOn: boolean;     // the road wears the wet material, kerbs and lines reflect
  streaks: RainStreaks | null; lens: LensDrops | null; spray: Spray | null; budget: WeatherQuality | null;
  env: { level: number; maps: (THREE.Texture | null)[]; scene: THREE.Scene | null; current: THREE.Texture | null; recheck: number };
  car: { cockpit: object | null; box: THREE.Box3 };
}

const _c = new THREE.Color(), _c3 = new THREE.Color();
const WET_TINT = { gravel: new THREE.Color(0.62, 0.6, 0.58), terrain: new THREE.Color(0.74, 0.8, 0.68), wall: new THREE.Color(0.84, 0.84, 0.84), kerb: new THREE.Color(0.82, 0.8, 0.8) };

export class Weather {
  quality: WeatherQuality = 'full';
  private readonly target: WeatherState = { rain: 0, wetness: 0 };
  private readonly shown: WeatherState = { rain: 0, wetness: 0 };
  private started = false;
  readonly look = newLook();
  private built: Built | null = null;

  constructor(private readonly stage: WeatherStage, private readonly sound?: { readonly weather: WeatherState }) {}

  // The weather now (every frame, or whenever it changes). The first call is shown at once, later ones are eased to.
  set(s: Readonly<WeatherState>) {
    this.target.rain = clamp(s.rain || 0, 0, 1); this.target.wetness = clamp(s.wetness || 0, 0, 1);
    if (!this.started) { this.started = true; this.shown.rain = this.target.rain; this.shown.wetness = this.target.wetness; }
  }
  // The values shown now (eased).
  get state(): Readonly<WeatherState> { return this.shown; }
  // What is built (tests, measurements): nothing while dry.
  get parts() {
    const b = this.built;
    return b ? { streaks: !!b.streaks, lens: !!b.lens, spray: !!b.spray, wetRoad: b.wetOn, envMaps: b.env.maps.filter(Boolean).length } : null;
  }

  // Every frame, after the camera has moved and before the frame is drawn. dt: frame time, 0 while paused.
  update(dt: number, cam: WeatherCamera, cars: WeatherCars, remote?: WeatherRemote | null) {
    const t = this.target, s = this.shown;
    if (dt > 0) {
      const k = 1 - Math.exp(-dt / EASE);
      s.rain += (t.rain - s.rain) * k; s.wetness += (t.wetness - s.wetness) * k;
      if (Math.abs(t.rain - s.rain) < 1e-3) s.rain = t.rain;
      if (Math.abs(t.wetness - s.wetness) < 1e-3) s.wetness = t.wetness;
    }
    if (this.sound) { this.sound.weather.rain = s.rain; this.sound.weather.wetness = s.wetness; }
    if (s.rain === 0 && s.wetness === 0) { if (this.built) this.teardown(); return; }
    const b = this.built ?? (this.built = this.build());
    const look = weatherLook(s.rain, s.wetness, this.look, this.stage.light);
    this.applyLight(look);
    this.applySurfaces(b, look);
    this.applyEnv(b, look, dt);
    this.particles(b, look, dt, cam, cars, remote);
  }

  // Undo everything and free it (also what update does once both values are back at 0).
  dispose() { if (this.built) this.teardown(); }

  // ------------------------------------------------------------------------
  private build(): Built {
    const st = this.stage, sf = st.surfaces;
    const colors = new Map<THREE.MeshStandardMaterial, THREE.Color>(), rough = new Map<THREE.MeshStandardMaterial, number>();
    for (const m of [sf.lineMat, sf.kerbMat, sf.gravelMat, sf.wallMat, sf.terrain]) { colors.set(m, m.color.clone()); rough.set(m, m.roughness); }
    const { material: wetRoad, uniforms: roadU } = wetRoadMaterial(sf.roadMat);
    return {
      base: { colors, rough },
      wetRoad, roadU, wetOn: false, streaks: null, lens: null, spray: null, budget: null,
      env: { level: 0, maps: Array<THREE.Texture | null>(ENV_LEVELS + 1).fill(null), scene: null, current: st.env, recheck: 0 },
      car: { cockpit: null, box: new THREE.Box3() },
    };
  }

  private teardown() {
    const b = this.built!, st = this.stage;
    this.built = null;
    applyBase(st);
    const sky = st.sky.material;
    if (sky.defines?.WEATHER !== undefined) { delete sky.defines.WEATHER; sky.needsUpdate = true; }
    for (const [m, c] of b.base.colors) m.color.copy(c);
    for (const [m, r] of b.base.rough) m.roughness = r;
    if (b.wetOn) this.wetSurfaces(b, false);
    b.wetRoad.dispose(); b.roadU.uPuddleMap.value.dispose();
    this.dropParticles(b);
    if (b.env.current !== st.env) this.useEnv(b, st.env);
    for (const m of b.env.maps) m?.dispose();
    b.env.scene?.traverse((o) => { if (o instanceof THREE.Mesh && o.name === 'envGround') { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } else if (o instanceof THREE.Mesh && o.parent === b.env.scene) o.geometry.dispose(); });
    const lamps = b.env.scene?.getObjectByName('envLamps');
    if (lamps) disposeEnvLamps(lamps as THREE.Group);
  }

  private applyLight(look: WeatherLook) {
    const st = this.stage, f = st.scene.fog as THREE.FogExp2, base = st.light, k = base.cloudHidesKey;
    // Fogged far off, the scenery must meet the sky (whose colours are display space) in the same grey: the fog's
    // colour is the one that tone-maps to it.
    f.color.copy(base.fog).lerp(fogForDisplay(look.fog, st.renderer?.toneMappingExposure ?? 1, _c), look.overcast);
    f.density = look.fogDensity;
    // the sun goes behind the cloud and its light spreads into the sky's; floodlights shine on (k = 0)
    st.sun.intensity = base.sun * lerp(1, look.sun, k);
    st.hemi.intensity = base.hemi * lerp(1, look.hemi, k);
    st.hemi.color.copy(base.hemiSky).lerp(base.greySky, look.overcast);
    st.hemi.groundColor.copy(base.hemiGround).lerp(base.greyGround, look.overcast);
    const sky = st.sky.material, on = look.overcast > 0;
    if (on !== (sky.defines?.WEATHER !== undefined)) {
      sky.defines ??= {};
      if (on) sky.defines.WEATHER = ''; else delete sky.defines.WEATHER;
      sky.needsUpdate = true;
    }
    sky.uniforms.uOvercast.value = look.overcast; sky.uniforms.uRain.value = look.rain;
    (sky.uniforms.uFog.value as THREE.Color).setRGB(look.fog[0], look.fog[1], look.fog[2]);   // (the shader's colours are display space)
  }

  private applySurfaces(b: Built, look: WeatherLook) {
    const sf = this.stage.surfaces, w = look.wet, base = b.base;
    if ((w > 0) !== b.wetOn) this.wetSurfaces(b, w > 0);
    b.roadU.uWet.value = w; b.roadU.uPuddle.value = look.puddles;
    b.wetRoad.envMapIntensity = 0.2 + 0.35 * w;
    const tint = (m: THREE.MeshStandardMaterial, to: THREE.Color) => m.color.copy(base.colors.get(m)!).multiply(_c.setRGB(1, 1, 1).lerp(to, w));
    tint(sf.gravelMat, WET_TINT.gravel); tint(sf.terrain, WET_TINT.terrain); tint(sf.wallMat, WET_TINT.wall); tint(sf.kerbMat, WET_TINT.kerb);
    sf.kerbMat.roughness = lerp(base.rough.get(sf.kerbMat)!, 0.22, w); sf.kerbMat.envMapIntensity = w;
    sf.lineMat.roughness = lerp(base.rough.get(sf.lineMat)!, 0.3, w); sf.lineMat.envMapIntensity = 0.8 * w;
  }

  // The road onto its wet material and back; kerbs and lines get the reflections (each a shader change, so only
  // when the road gets wet or dries).
  private wetSurfaces(b: Built, on: boolean) {
    const sf = this.stage.surfaces, env = b.env.current;
    b.wetOn = on;
    sf.road.material = on ? b.wetRoad : sf.roadMat;
    for (const r of sf.laneRoads ?? []) r.material = on ? b.wetRoad : sf.roadMat;
    b.wetRoad.envMap = env;
    for (const m of [sf.kerbMat, sf.lineMat]) { m.envMap = on ? env : null; m.needsUpdate = true; }
  }

  // The reflections: the dry map while the sky is clear, else an overcast one for this much cloud and rain (made
  // the first time the weather gets there, from the sky as it is then).
  private applyEnv(b: Built, look: WeatherLook, dt: number) {
    const e = b.env, renderer = this.stage.renderer;
    if (!renderer || !this.stage.env) return;
    const level = Math.round((0.6 * look.overcast + 0.4 * look.rain) * ENV_LEVELS);
    e.recheck -= dt;
    if (level === e.level && e.recheck > 0) return;
    e.recheck = 1;   // again each second: catches cars built since (a car switch, another player) with an old map
    e.level = level;
    let map = level === 0 ? this.stage.env : e.maps[level];
    if (!map) {
      if (!e.scene) {
        e.scene = new THREE.Scene();
        e.scene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), this.stage.sky.material));
        const ground = new THREE.Mesh(new THREE.CircleGeometry(45, 32), new THREE.MeshBasicMaterial({ color: this.stage.light.envGround.clone().multiplyScalar(0.7) }));
        ground.name = 'envGround'; ground.rotation.x = -Math.PI / 2; ground.position.y = -2;
        e.scene.add(ground);
        if (this.stage.light.lamps > 0) e.scene.add(envLamps(this.stage.light.lamps));   // the floodlights in the wet road
      }
      const pmrem = new THREE.PMREMGenerator(renderer);
      map = e.maps[level] = pmrem.fromScene(e.scene, 0.02, 0.1, 100, { size: ENV_SIZE }).texture;
      pmrem.dispose();
    }
    this.useEnv(b, map);
  }

  // Every material reflecting one of our maps (cars, the wet road, kerbs, lines) onto `map`; new cars get it too.
  private useEnv(b: Built, map: THREE.Texture | null) {
    const ours = new Set<THREE.Texture | null>([this.stage.env, ...b.env.maps]);
    this.stage.scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m instanceof THREE.MeshStandardMaterial && m.envMap && m.envMap !== map && ours.has(m.envMap)) m.envMap = map;
      }
    });
    if (b.wetRoad.envMap) b.wetRoad.envMap = map;
    b.env.current = map;
    setCarEnvironment(map);
  }

  private dropParticles(b: Built) {
    b.streaks?.dispose(); b.lens?.dispose(); b.spray?.dispose();
    b.streaks = b.lens = b.spray = null; b.budget = null;
    this.stage.camera.layers.disable(LENS_LAYER);
  }

  private particles(b: Built, look: WeatherLook, dt: number, cam: WeatherCamera, cars: WeatherCars, remote?: WeatherRemote | null) {
    const st = this.stage, q = WEATHER_BUDGET[this.quality];
    if (b.budget !== this.quality) { this.dropParticles(b); b.budget = this.quality; }
    // rain round the camera
    if (q.streaks && look.rain > 0) {
      if (!b.streaks) st.scene.add((b.streaks = new RainStreaks(q.streaks)).mesh);
      const car = cars.car, mc = b.car;
      if (mc.cockpit !== car.mesh.cockpit) { bodyBox(car.mesh.root, mc.box); mc.cockpit = car.mesh.cockpit; }
      const height = st.renderer ? st.renderer.domElement.height : 720;
      b.streaks.update(dt, look.rain, st.camera, height, car.vel, display(_c, look.mist, 1.3),
        { root: car.mesh.root, box: mc.box });
    } else if (b.streaks) { b.streaks.dispose(); b.streaks = null; }
    // drops on the lens or visor
    if (q.lens && (look.rain > 0 || b.lens)) {
      if (!b.lens) { st.scene.add((b.lens = new LensDrops()).mesh); st.camera.layers.enable(LENS_LAYER); }
      const lensCam = (cam.mode === 'onboard' || cam.mode === 'driver') && !cam.lookBack;
      b.lens.update(dt, look.rain, lensCam, Math.abs(cars.car.speedF), st.camera.aspect, display(_c, look.mist, 1.15), _c3.setRGB(0.16, 0.17, 0.18));
    }
    // spray behind the cars
    if (q.spray && look.spray > 0) {
      if (!b.spray) st.scene.add((b.spray = new Spray(q.spray)).mesh);
      const p = st.camera.position, far2 = SPRAY_FAR * SPRAY_FAR, sp = b.spray;
      const emit = (c: SprayCar, alpha = 1) => { if (c.root.position.distanceToSquared(p) < far2) sp.emit(c, dt, look.spray, q.sprayShare, alpha); };
      emit(asSpray(cars.car), OWN_SPRAY);
      for (const o of cars.others) emit(asSpray(o.car));
      if (remote) for (const c of remote.drawn) emit(c);
    }
    if (b.spray) {
      // the mist catches the sky's light, whiter in sunshine
      b.spray.update(dt, st.camera, display(_c, look.mist, 1.06 + 0.12 * look.sun), look.fogDensity);
    }
  }
}

// (the tone mapping maths moved to timeOfDay.ts with the time of day; kept here for weather's tests and callers)
export { fogForDisplay, toneMap } from './timeOfDay';

// The particles' shaders write display-space colours (as the sky's and the dust's do): the fog's colour, brighter.
const display = (c: THREE.Color, fog: Readonly<RGB>, k: number) => c.setRGB(Math.min(1, fog[0] * k), Math.min(1, fog[1] * k), Math.min(1, fog[2] * k));

// A Vehicle as a spray source (one object per vehicle, reused).
const sprayOf = new WeakMap<Vehicle, SprayCar>();
function asSpray(v: Vehicle): SprayCar {
  let s = sprayOf.get(v);
  if (!s || s.root !== v.mesh.root) sprayOf.set(v, (s = { root: v.mesh.root, spec: v.spec, vel: v.vel, wheels: v.wheels }));
  return s;
}

// ============================================================================
// The wet road: a copy of the road's material whose shader darkens it and makes it glossy by uWet (patchily while
// only damp: the water lies unevenly), and adds puddles by uPuddle: a tiling noise map in world metres, sampled at
// two scales so the tiling does not show, thresholded lower the more water there is; a puddle is darker and nearly a
// mirror for the sky. Only the road mesh wears it, and only while the track is wet.
// ============================================================================
export function wetRoadMaterial(base: THREE.MeshStandardMaterial) {
  const material = base.clone();
  const uniforms = { uWet: { value: 0 }, uPuddle: { value: 0 }, uPuddleMap: { value: puddleMap() as THREE.Texture } };
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWxz;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWxz = (modelMatrix * vec4(transformed, 1.)).xz * vec2(sign(modelMatrix[0][0]), 1.);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWxz; uniform float uWet, uPuddle; uniform sampler2D uPuddleMap;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        float m1 = texture2D(uPuddleMap, vWxz / 29.).r, m2 = texture2D(uPuddleMap, vWxz.yx / 71. + 0.37).r;
        float wetL = clamp(uWet * (0.4 + 1.2 * m1), 0., 1.);
        float th = 1. - 0.36 * uPuddle;
        float pud = uPuddle > 0. ? smoothstep(th, th + 0.09, 0.55 * m1 + 0.45 * m2) : 0.;
        diffuseColor.rgb *= (1. - 0.55 * wetL) * (1. - 0.3 * pud);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(mix(roughnessFactor, 0.38, wetL), 0.1, pud);`);
  };
  material.customProgramCacheKey = () => 'wetRoad';
  return { material, uniforms };
}

// 128 x 128 tiling value noise (three octaves), 0..255 in the red channel.
export function puddleMap() {
  const n = 128, data = new Uint8Array(n * n * 4);
  const octaves = [[8, 0.55], [16, 0.3], [32, 0.15]] as const;
  const grids = octaves.map(([g]) => Float32Array.from({ length: g * g }, () => Math.random()));
  const fade = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let v = 0;
    octaves.forEach(([g, a], k) => {
      const gx = (x / n) * g, gy = (y / n) * g, ix = Math.floor(gx), iy = Math.floor(gy), fx = fade(gx - ix), fy = fade(gy - iy);
      const at = (i: number, j: number) => grids[k][((j % g) * g) + (i % g)];
      v += a * lerp(lerp(at(ix, iy), at(ix + 1, iy), fx), lerp(at(ix, iy + 1), at(ix + 1, iy + 1), fx), fy);
    });
    const i = (y * n + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = Math.round(clamp(v, 0, 1) * 255); data[i + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
