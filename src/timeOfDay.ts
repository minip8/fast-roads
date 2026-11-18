import * as THREE from 'three';
import { clamp } from './util';

// ============================================================================
// Time of day: the light each circuit is raced in, and the base that the weather (weather.ts) changes.
//
// Each circuit names one look (TrackDef.light) and the sun's compass bearing at its race (TrackDef.sunAz). The day
// looks differ in the sun's height and colour, the sky, the haze and the cloud; dusk is a low sun in a warm-to-blue
// sky with the floodlights coming on; night is a dark sky with stars and a glow over the city, the circuit floodlit:
// the key light is the floodlights, nearly overhead (its soft shadow keeps the cars on the ground), and the light
// falls away beyond the circuit (`FloodLight`: a darkening by distance from the track that the scenery's materials
// take, so the road, kerbs, walls, boards and cars stay as readable as by day). The Time of day setting can show any
// circuit by day, at dusk or at night (`lookFor`); ?time=night (or any look's id) does the same for development.
//
// Colours marked display are sRGB as shown on screen (the sky shader's colours are display space); the fog's colour is
// the linear one that the renderer's tone mapping turns into the sky's horizon (fogForDisplay), so far scenery meets
// the sky in the same colour at every time and Brightness.
// ============================================================================
export type RGB = [number, number, number];
export type Phase = 'day' | 'dusk' | 'night';
export type LightId = 'clear' | 'high' | 'haze' | 'golden' | 'northern' | 'desert' | 'dusk' | 'night';
export type TimeChoice = 'circuit' | 'day' | 'dusk' | 'night';   // the Time of day setting

export interface Look {
  id: LightId; phase: Phase;
  sunElev: number;             // deg: the key light's elevation (at night the floodlights', nearly overhead)
  sun: number; sunIntensity: number;            // key light colour (hex) and intensity
  fill: number;                // the floodlights from overhead while the sun is still the key light (dusk)
  hemiSky: number; hemiGround: number; hemiIntensity: number;
  zenith: RGB; horizon: RGB;   // sky, display; the fog's colour is the horizon's
  fogDensity: number;
  sunDisc: RGB; sunGlow: number;   // the disc (or the moon at night) and its halo's strength, display
  discSize: number;            // the disc's sharpness (the sky shader's exponent: larger is smaller)
  skyElev: number;             // deg: the disc's elevation in the sky (the sun's; the moon's at night)
  band: number;                // dusk: the warm band along the horizon towards the sun (sunDisc's colour)
  glow: RGB;                   // a glow low all round the horizon (a city's lights), display
  clouds: number;              // cloud cover 0..1 (0.5 the plain day's)
  cloudLit: RGB; cloudShade: RGB;   // cloud tops and undersides, display
  stars: number;
  flood: number;               // the floodlights: 0 off, else how light it stays far beyond the circuit (1 = no darkening)
  lamps: number;               // lamps, windows and signs alight 0..1
  // under the weather
  cloudHidesKey: number;       // how much cloud dims the key light: 1 the sun, 0 floodlights
  overcastFog: RGB; rainFog: RGB;   // the fog's (and horizon's) colour under cloud and in a downpour, display
  mistLift: number;            // spray and rain lit brighter than the fog (floodlights in the spray), display
  greySky: number; greyGround: number;   // the hemisphere light under cloud
  envGround: RGB;              // the ground in the reflections (linear)
}

const DAY_WEATHER = { cloudHidesKey: 1, overcastFog: [0.66, 0.70, 0.74] as RGB, rainFog: [0.47, 0.50, 0.54] as RGB, mistLift: 0, greySky: 0xdfe3e8, greyGround: 0x4c5444 };
const DAY_SKY = { fill: 0, sunDisc: [1.0, 0.92, 0.75] as RGB, sunGlow: 1, discSize: 900, band: 0, glow: [0, 0, 0] as RGB, stars: 0, flood: 1, lamps: 0, cloudLit: [1.0, 0.99, 0.97] as RGB, cloudShade: [0.74, 0.79, 0.86] as RGB, envGround: [0.16, 0.2, 0.13] as RGB };

export const LOOKS: Record<LightId, Look> = {
  // The plain day the game always had: a sun 47 deg up, fair-weather cloud.
  clear: { id: 'clear', phase: 'day', ...DAY_SKY, ...DAY_WEATHER, sunElev: 47, skyElev: 47, sun: 0xfff1dc, sunIntensity: 3.0, hemiSky: 0xcfe3ff, hemiGround: 0x5a6a40, hemiIntensity: 1.1,
    zenith: [0.28, 0.52, 0.86], horizon: [0.80, 0.87, 0.93], fogDensity: 0.00042, clouds: 0.5 },
  // A high, hard sun in thin clear air: short black shadows, a deep blue sky, little cloud.
  high: { id: 'high', phase: 'day', ...DAY_SKY, ...DAY_WEATHER, sunElev: 68, skyElev: 68, sun: 0xfffaf0, sunIntensity: 3.4, hemiSky: 0xbfd8ff, hemiGround: 0x5e6a44, hemiIntensity: 0.95,
    zenith: [0.16, 0.40, 0.84], horizon: [0.70, 0.82, 0.95], fogDensity: 0.0003, clouds: 0.3 },
  // Summer haze: a milky pale sky, a softened sun, the distance washed out.
  haze: { id: 'haze', phase: 'day', ...DAY_SKY, ...DAY_WEATHER, sunElev: 52, skyElev: 52, sun: 0xfff0d8, sunIntensity: 2.6, hemiSky: 0xe2e6ea, hemiGround: 0x67704a, hemiIntensity: 1.3,
    zenith: [0.46, 0.62, 0.84], horizon: [0.88, 0.88, 0.86], fogDensity: 0.0009, sunGlow: 2.2, clouds: 0.22, cloudShade: [0.80, 0.82, 0.86] },
  // Low autumn light late in the afternoon: a warm sun 22 deg up, long shadows, a golden haze low down.
  golden: { id: 'golden', phase: 'day', ...DAY_SKY, ...DAY_WEATHER, sunElev: 22, skyElev: 22, sun: 0xffd9a8, sunIntensity: 2.9, hemiSky: 0xc4d2f0, hemiGround: 0x6a5e3c, hemiIntensity: 1.0,
    zenith: [0.27, 0.48, 0.82], horizon: [0.93, 0.86, 0.75], fogDensity: 0.0005, sunDisc: [1.0, 0.82, 0.55], sunGlow: 1.6, band: 0.25, clouds: 0.42,
    cloudLit: [1.0, 0.94, 0.84], cloudShade: [0.70, 0.70, 0.78] },
  // A northern summer afternoon: a softer, whiter sun among plenty of fair-weather cumulus, a cooler sky.
  northern: { id: 'northern', phase: 'day', ...DAY_SKY, ...DAY_WEATHER, sunElev: 42, skyElev: 42, sun: 0xfff6ea, sunIntensity: 2.7, hemiSky: 0xd2e0f4, hemiGround: 0x56683e, hemiIntensity: 1.25,
    zenith: [0.30, 0.50, 0.80], horizon: [0.78, 0.85, 0.92], fogDensity: 0.00055, clouds: 0.7, cloudShade: [0.68, 0.73, 0.81] },
  // The desert by day: a bleached sky, dust on the horizon, a hot sun and warm bounce light off the sand.
  desert: { id: 'desert', phase: 'day', ...DAY_SKY, ...DAY_WEATHER, sunElev: 56, skyElev: 56, sun: 0xfff3e0, sunIntensity: 3.2, hemiSky: 0xd6e2f6, hemiGround: 0x8c7650, hemiIntensity: 1.1,
    zenith: [0.30, 0.54, 0.88], horizon: [0.90, 0.86, 0.78], fogDensity: 0.0006, clouds: 0.1, envGround: [0.36, 0.28, 0.18] },
  // Dusk: the sun 4 deg up and orange, a warm horizon under a deepening blue, the floodlights coming on.
  dusk: { id: 'dusk', phase: 'dusk', sunElev: 4, skyElev: 4, sun: 0xffa060, sunIntensity: 2.1, fill: 1.5, hemiSky: 0xb0b2d4, hemiGround: 0x6a5a48, hemiIntensity: 1.75,
    zenith: [0.13, 0.20, 0.44], horizon: [0.96, 0.62, 0.40], fogDensity: 0.00045, sunDisc: [1.0, 0.62, 0.30], sunGlow: 1.8, discSize: 1600, band: 1,
    glow: [0.05, 0.03, 0.03], clouds: 0.38, cloudLit: [1.0, 0.64, 0.50], cloudShade: [0.36, 0.34, 0.50], stars: 0, flood: 0.55, lamps: 0.7,
    cloudHidesKey: 1, overcastFog: [0.40, 0.39, 0.43], rainFog: [0.30, 0.30, 0.34], mistLift: 0.06, greySky: 0x9a9eb0, greyGround: 0x3a3a38, envGround: [0.12, 0.1, 0.09] },
  // Night under floodlights: the key light is the lights, high overhead and white; beyond the circuit it is dark.
  night: { id: 'night', phase: 'night', sunElev: 72, skyElev: 38, sun: 0xeef2ff, sunIntensity: 2.3, fill: 0, hemiSky: 0xa0aed0, hemiGround: 0x46443c, hemiIntensity: 0.9,
    zenith: [0.012, 0.02, 0.052], horizon: [0.10, 0.10, 0.14], fogDensity: 0.0005, sunDisc: [0.55, 0.58, 0.62], sunGlow: 0.25, discSize: 9000, band: 0,
    glow: [0.12, 0.08, 0.05], clouds: 0.25, cloudLit: [0.10, 0.10, 0.13], cloudShade: [0.035, 0.04, 0.065], stars: 1, flood: 0.12, lamps: 1,
    cloudHidesKey: 0, overcastFog: [0.11, 0.11, 0.13], rainFog: [0.15, 0.155, 0.17], mistLift: 0.22, greySky: 0x9aa0ac, greyGround: 0x404040, envGround: [0.08, 0.08, 0.08] },
};
export const TIME_CHOICES: TimeChoice[] = ['circuit', 'day', 'dusk', 'night'];

// What a circuit shows for the Time of day setting: its own look, or (for Day) its own if raced by day, else a clear
// day (the desert's at a desert circuit).
export function lookFor(own: LightId, choice: TimeChoice | LightId, desert = false): Look {
  if (choice in LOOKS) return LOOKS[choice as LightId];
  if (choice === 'dusk' || choice === 'night') return LOOKS[choice];
  if (choice === 'day') return LOOKS[own].phase === 'day' ? LOOKS[own] : LOOKS[desert ? 'desert' : 'clear'];
  return LOOKS[own];
}

// The dev flag: ?time=night (or day, dusk, circuit, or any look's id). null: not given or unknown.
export function timeFromUrl(params: URLSearchParams): TimeChoice | LightId | null {
  const t = params.get('time');
  return t != null && (t in LOOKS || (TIME_CHOICES as string[]).includes(t)) ? (t as TimeChoice | LightId) : null;
}

// World direction (x east, z south) towards a light at this elevation and compass bearing (deg).
export function lightDir(elevDeg: number, bearingDeg: number, out = new THREE.Vector3()) {
  const e = (elevDeg * Math.PI) / 180, b = (bearingDeg * Math.PI) / 180;
  return out.set(Math.cos(e) * Math.sin(b), Math.sin(e), -Math.cos(e) * Math.cos(b)).normalize();
}

// ----------------------------------------------------------------------------
// The base the weather modifies: the dry values of everything weather.ts changes, for the look shown now. Live: the
// stage rewrites it when the time of day or Brightness changes, and the weather reads it every frame.
export interface LightBase {
  fog: THREE.Color; fogDisplay: RGB; fogDensity: number;
  sun: number; hemi: number; hemiSky: THREE.Color; hemiGround: THREE.Color;
  cloudHidesKey: number; overcastFog: RGB; rainFog: RGB; mistLift: number;
  greySky: THREE.Color; greyGround: THREE.Color; envGround: THREE.Color;
  lamps: number;               // lamps in the reflections (weather's overcast maps draw them too)
}
export function lightBase(look: Look, exposure = 1, out?: LightBase): LightBase {
  const b = out ?? { fog: new THREE.Color(), fogDisplay: [0, 0, 0], fogDensity: 0, sun: 0, hemi: 0, hemiSky: new THREE.Color(), hemiGround: new THREE.Color(),
    cloudHidesKey: 1, overcastFog: [0, 0, 0], rainFog: [0, 0, 0], mistLift: 0, greySky: new THREE.Color(), greyGround: new THREE.Color(), envGround: new THREE.Color(), lamps: 0 };
  fogForDisplay(look.horizon, exposure, b.fog);
  b.fogDisplay = [...look.horizon]; b.fogDensity = look.fogDensity;
  b.sun = look.sunIntensity; b.hemi = look.hemiIntensity; b.hemiSky.set(look.hemiSky); b.hemiGround.set(look.hemiGround);
  b.cloudHidesKey = look.cloudHidesKey; b.overcastFog = [...look.overcastFog]; b.rainFog = [...look.rainFog]; b.mistLift = look.mistLift;
  b.greySky.set(look.greySky); b.greyGround.set(look.greyGround); b.envGround.setRGB(...look.envGround); b.lamps = look.lamps;
  return b;
}
// Puts the base's values on the stage (the dry state; also what the weather restores when it is dry again).
export interface LitStage {
  scene: THREE.Scene; sun: THREE.DirectionalLight; hemi: THREE.HemisphereLight;
  sky: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>; light: LightBase;
}
export function applyBase(st: LitStage) {
  const f = st.scene.fog as THREE.FogExp2, b = st.light;
  f.color.copy(b.fog); f.density = b.fogDensity;
  st.sun.intensity = b.sun; st.hemi.intensity = b.hemi; st.hemi.color.copy(b.hemiSky); st.hemi.groundColor.copy(b.hemiGround);
}
// The sky shader's uniforms for a look (scenery.ts buildSky; display colours).
export function skyUniforms(look: Look, sky: THREE.ShaderMaterial, sunBearing: number) {
  const u = sky.uniforms;
  lightDir(look.skyElev, look.phase === 'night' ? sunBearing + 140 : sunBearing, u.sunDir.value as THREE.Vector3);
  (u.uZenith.value as THREE.Color).setRGB(...look.zenith); (u.uHorizon.value as THREE.Color).setRGB(...look.horizon);
  (u.uSunCol.value as THREE.Color).setRGB(...look.sunDisc); u.uSunGlow.value = look.sunGlow; u.uSunSize.value = look.discSize; u.uBand.value = look.band;
  (u.uGlow.value as THREE.Color).setRGB(...look.glow); u.uClouds.value = look.clouds; u.uStars.value = look.stars;
  (u.uCloudLit.value as THREE.Color).setRGB(...look.cloudLit); (u.uCloudShade.value as THREE.Color).setRGB(...look.cloudShade);
}

// The lamps as the reflections see them (the environment maps of cars, the wet road, kerbs): a ring of bright spots
// low round the sky over a band of lit stands and buildings along the horizon (what a wet road at night mirrors), for
// an environment scene of radius ~50 (stage.ts, weather.ts). Free it with disposeEnvLamps.
export function envLamps(lamps: number): THREE.Group {
  const g = new THREE.Group(), geo = new THREE.SphereGeometry(1.1, 8, 6);
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(7, 6.8, 6.2).multiplyScalar(lamps), fog: false });
  for (let k = 0; k < 18; k++) {
    const a = (k / 18) * Math.PI * 2 + (k % 3) * 0.07, e = 0.2 + 0.18 * ((k * 7) % 5) / 4;
    const m = new THREE.Mesh(geo, mat);
    m.position.set(Math.cos(a) * Math.cos(e) * 40, Math.sin(e) * 40, Math.sin(a) * Math.cos(e) * 40);
    g.add(m);
  }
  const band = new THREE.Mesh(new THREE.CylinderGeometry(42, 42, 5, 32, 1, true),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0.55, 0.52, 0.48).multiplyScalar(lamps), side: THREE.BackSide, fog: false }));
  band.position.y = 2;
  g.add(band);
  g.name = 'envLamps';
  return g;
}
export function disposeEnvLamps(g: THREE.Group) {
  const seen = new Set<object>();
  for (const o of g.children) {
    const m = o as THREE.Mesh;
    for (const x of [m.geometry, m.material as THREE.Material]) if (!seen.has(x)) { seen.add(x); x.dispose(); }
  }
}

// ----------------------------------------------------------------------------
// Lamps, lit windows and signs: materials whose glow follows Look.lamps (0 by day). A standard
// (or Lambert) material's emissive intensity goes from `off` to `on`; a basic or points material's colour is scaled
// (and hidden at 0).
export class Glow {
  private readonly list: { m: THREE.Material; on: number; off: number; base: THREE.Color | null }[] = [];
  add<M extends THREE.Material>(m: M, on: number, off = 0): M {
    const c = (m as unknown as { color?: THREE.Color }).color;
    this.list.push({ m, on, off, base: c ? c.clone() : null });
    return m;
  }
  set(lamps: number) {
    for (const g of this.list) {
      const k = g.off + (g.on - g.off) * lamps;
      if (g.m instanceof THREE.MeshStandardMaterial || g.m instanceof THREE.MeshLambertMaterial) g.m.emissiveIntensity = k;
      else if (g.base) (g.m as unknown as { color: THREE.Color }).color.copy(g.base).multiplyScalar(k);
      if (g.m instanceof THREE.PointsMaterial) g.m.visible = k > 0;
    }
  }
}

// ----------------------------------------------------------------------------
// Floodlit at night: the scenery's materials (terrain, trees, hills, buildings) take a darkening by their distance
// from the circuit, read from a small texture over the circuit's area (1 on and near the track, falling to 0 some 100 m
// beyond its walls). By day the darkening is 1 everywhere, a 1-pixel white map: nothing changes. Only reflected light
// is darkened, so windows and lamps (emissive) still glow.
export const flood = {
  uFloodMap: { value: whitePixel() as THREE.Texture },
  uFloodBox: { value: new THREE.Vector4(0, 0, 1, 1) },   // x0, z0, 1/width, 1/depth (m)
  uFloodDark: { value: 1 },                               // the light far from the circuit (Look.flood)
};
function whitePixel() {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}
// Makes a material take the floodlights' darkening (shared uniforms; one shader per material type and options).
export function floodlit<M extends THREE.Material>(m: M): M {
  const prev = m.onBeforeCompile.bind(m);
  m.onBeforeCompile = (sh, r) => {
    prev(sh, r);
    Object.assign(sh.uniforms, flood);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vFloodXZ;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 fw = vec4(transformed, 1.);
        #ifdef USE_INSTANCING
        fw = instanceMatrix * fw;
        #endif
        vFloodXZ = (modelMatrix * fw).xz * vec2(sign(modelMatrix[0][0]), 1.);`);   // (the mirror pass flips the scene in x)
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vFloodXZ; uniform sampler2D uFloodMap; uniform vec4 uFloodBox; uniform float uFloodDark;')
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        float floodK = mix(uFloodDark, 1., texture2D(uFloodMap, (vFloodXZ - uFloodBox.xy) * uFloodBox.zw).r);
        reflectedLight.directDiffuse *= floodK; reflectedLight.indirectDiffuse *= floodK;
        reflectedLight.directSpecular *= floodK; reflectedLight.indirectSpecular *= floodK;`);
  };
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => key() + '|flood';
  return m;
}

// The floodlights' reach: 1 within `lit` m of the centreline (beyond the walls), down to 0 `fade` m further, from the
// track's samples, over the circuit's area at about 4 m a texel (at most 1024 a side).
export function floodMap(X: ArrayLike<number>, Z: ArrayLike<number>, reach: (i: number) => number, fade = 110) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < X.length; i++) { x0 = Math.min(x0, X[i]); x1 = Math.max(x1, X[i]); z0 = Math.min(z0, Z[i]); z1 = Math.max(z1, Z[i]); }
  const pad = 80 + fade; x0 -= pad; z0 -= pad; x1 += pad; z1 += pad;
  const cell = Math.max(4, (x1 - x0) / 1024, (z1 - z0) / 1024);
  const w = Math.ceil((x1 - x0) / cell), h = Math.ceil((z1 - z0) / cell), v = new Float32Array(w * h);
  for (let i = 0; i < X.length; i += 2) {
    const r0 = reach(i), r1 = r0 + fade, cx = (X[i] - x0) / cell, cz = (Z[i] - z0) / cell, rc = r1 / cell;
    for (let gz = Math.max(0, Math.floor(cz - rc)); gz <= Math.min(h - 1, Math.ceil(cz + rc)); gz++) {
      for (let gx = Math.max(0, Math.floor(cx - rc)); gx <= Math.min(w - 1, Math.ceil(cx + rc)); gx++) {
        const d = Math.hypot(gx + 0.5 - cx, gz + 0.5 - cz) * cell;
        if (d >= r1) continue;
        const t = clamp((d - r0) / fade, 0, 1), k = 1 - t * t * (3 - 2 * t);
        if (k > v[gz * w + gx]) v[gz * w + gx] = k;
      }
    }
  }
  const data = new Uint8Array(w * h * 4);
  for (let k = 0; k < w * h; k++) data[k * 4] = data[k * 4 + 1] = data[k * 4 + 2] = Math.round(v[k] * 255), data[k * 4 + 3] = 255;
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.magFilter = tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
  return { tex, box: new THREE.Vector4(x0, z0, 1 / (w * cell), 1 / (h * cell)) };
}

// ----------------------------------------------------------------------------
// three.js's ACES filmic tone mapping (tonemapping_pars_fragment), linear in, display (sRGB) out.
const ACES_IN = [[0.59719, 0.35458, 0.04823], [0.07600, 0.90834, 0.01566], [0.02840, 0.13383, 0.83777]];
const ACES_OUT = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]];
const rrt = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081);
const _lin = new THREE.Color(), _c2 = new THREE.Color(), _tm = [0, 0, 0], _a = [0, 0, 0];
export function toneMap(lin: readonly number[], exposure: number, out: number[] = [0, 0, 0]) {
  for (let i = 0; i < 3; i++) _a[i] = rrt((ACES_IN[i][0] * lin[0] + ACES_IN[i][1] * lin[1] + ACES_IN[i][2] * lin[2]) * exposure / 0.6);
  for (let i = 0; i < 3; i++) out[i] = clamp(ACES_OUT[i][0] * _a[0] + ACES_OUT[i][1] * _a[1] + ACES_OUT[i][2] * _a[2], 0, 1);
  _lin.setRGB(out[0], out[1], out[2]).convertLinearToSRGB();
  out[0] = _lin.r; out[1] = _lin.g; out[2] = _lin.b;
  return out;
}
// The linear colour that the renderer shows as `display` (sRGB): found by iterating, the mapping is monotonic.
export function fogForDisplay(display: readonly number[], exposure: number, out: THREE.Color) {
  const want = _c2.setRGB(display[0], display[1], display[2], THREE.SRGBColorSpace), l = [want.r, want.g, want.b], w = [want.r, want.g, want.b];
  for (let k = 0; k < 16; k++) {
    toneMap(l, exposure, _tm);
    _lin.setRGB(_tm[0], _tm[1], _tm[2], THREE.SRGBColorSpace);
    l[0] *= w[0] / Math.max(1e-4, _lin.r); l[1] *= w[1] / Math.max(1e-4, _lin.g); l[2] *= w[2] / Math.max(1e-4, _lin.b);
  }
  return out.setRGB(l[0], l[1], l[2]);
}
