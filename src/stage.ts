import * as THREE from 'three';
import { buildBrakeMarkers } from './brakeMarkers';
import { setCarEnvironment } from './carMeshes';
import { installCarModels } from './carModels';
import { buildScenery, buildSky } from './scenery';
import { applyBase, disposeEnvLamps, envLamps, flood, floodMap, Glow, lightBase, lightDir, lookFor, LOOKS, skyUniforms, type LightId, type Look, type TimeChoice } from './timeOfDay';
import type { Track } from './track';
import type { TrackDef } from './tracks';
import { buildTrackMeshes } from './trackMeshes';
import { buildTrackside } from './trackside';

// ============================================================================
// Renderer, scene, lights and everything static around the circuit
// ============================================================================
const SHADOW_HALF = 60, SHADOW_AHEAD = 28, SUN_DIST = 250;
// Shadow map size for each Shadows setting (0: the sun casts none).
export const SHADOW_MAPS = { off: 0, low: 1024, high: 2048 };
export type ShadowQuality = keyof typeof SHADOW_MAPS;
export type SceneryDetail = 'high' | 'low';
const UP = new THREE.Vector3(0, 1, 0);

export function buildStage(canvas: HTMLCanvasElement, track: Track, def: TrackDef, time: TimeChoice | LightId = 'circuit') {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
  let resolution = 1;   // the Render resolution setting: a share of the screen's pixels (up to 2 per CSS pixel)
  const pixelRatio = () => Math.min(devicePixelRatio, 2) * resolution;
  renderer.setPixelRatio(pixelRatio());
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xffffff, 0.00042);   // (colour and density: the time of day's, setTime)
  const camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.1, 9000);

  // The key light: the sun, or at night the floodlights, nearly overhead. sunDir points towards it.
  const sunDir = new THREE.Vector3(0, 1, 0), skyDir = new THREE.Vector3(0, 1, 0);
  const sky = buildSky(scene, skyDir);
  installCarModels();   // cars with a model file swap it in when it has loaded
  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x5a6a40, 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1dc, 3.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAPS.high, SHADOW_MAPS.high);
  Object.assign(sun.shadow.camera, { left: -SHADOW_HALF, right: SHADOW_HALF, top: SHADOW_HALF, bottom: -SHADOW_HALF, near: SUN_DIST - 120, far: SUN_DIST + 120 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  // Light-space axes, for snapping the shadow camera to whole shadow-map texels: without it, shadow edges crawl
  // as the car moves.
  const lx = new THREE.Vector3(), ly = new THREE.Vector3();
  let texel = (2 * SHADOW_HALF) / SHADOW_MAPS.high;
  const centre = new THREE.Vector3();
  // Centre the shadow map a little ahead of the view (where shadows are seen), snapped to texels.
  const followSun = (p: THREE.Vector3, viewDir: THREE.Vector3) => {
    const h = Math.hypot(viewDir.x, viewDir.z) || 1;
    centre.set(p.x + (viewDir.x / h) * SHADOW_AHEAD, p.y, p.z + (viewDir.z / h) * SHADOW_AHEAD);
    const a = Math.round(centre.dot(lx) / texel) * texel, b = Math.round(centre.dot(ly) / texel) * texel, c = centre.dot(sunDir);
    centre.copy(lx).multiplyScalar(a).addScaledVector(ly, b).addScaledVector(sunDir, c);
    sun.target.position.copy(centre);
    sun.position.copy(centre).addScaledVector(sunDir, SUN_DIST);
  };

  const glow = new Glow();   // lamps, lit windows and signs (on at dusk and night)
  const trackMaterials = buildTrackMeshes(track, scene);
  const { bounds, terrain } = buildScenery(track, scene, def, glow);
  const trackside = buildTrackside(track, def, scene, glow, trackMaterials.lineMat);
  const brakeMarkers = buildBrakeMarkers(track, scene);

  const fit = () => {
    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  };
  // Also catches devicePixelRatio changes (browser zoom, moving the window to another monitor).
  addEventListener('resize', fit);

  // Graphics settings
  const setResolution = (share: number) => { if (share !== resolution) { resolution = share; fit(); } };
  const setShadows = (q: ShadowQuality) => {
    const size = SHADOW_MAPS[q];
    sun.castShadow = size > 0;   // changes the lights' state, so materials pick up the change by themselves
    if (size && sun.shadow.mapSize.x !== size) {
      sun.shadow.mapSize.set(size, size);
      sun.shadow.map?.dispose(); sun.shadow.map = null;   // rebuilt at the new size on the next render
      texel = (2 * SHADOW_HALF) / size;
    }
  };
  // Brightness is the tone mapping's exposure; the fog's colour follows, so far scenery still meets the sky.
  const setBrightness = (exposure: number) => {
    renderer.toneMappingExposure = exposure;
    lightBase(stage.look, exposure, stage.light);
    applyBase(stage);
  };
  const setDetail = (level: SceneryDetail) => trackside.setDetail(level);

  // The reflections (cars' paint and glass, the wet road): the sky as it is now over a dark ground, with the lamps
  // at dusk and night. Every material reflecting the old map is moved onto the new one.
  const makeEnv = (look: Look) => {
    const envScene = new THREE.Scene(), pmrem = new THREE.PMREMGenerator(renderer);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), sky.material);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(45, 32), new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(...look.envGround) }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -2;
    const lamps = look.lamps > 0 ? envLamps(look.lamps) : null;
    envScene.add(dome, ground);
    if (lamps) envScene.add(lamps);
    const tex = pmrem.fromScene(envScene, 0.02).texture;
    pmrem.dispose(); dome.geometry.dispose(); ground.geometry.dispose(); ground.material.dispose();
    if (lamps) disposeEnvLamps(lamps);
    return tex;
  };
  const useEnv = (env: THREE.Texture) => {
    const old = stage.env;
    if (old) scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m instanceof THREE.MeshStandardMaterial && m.envMap === old) m.envMap = env;
    });
    stage.env = env;
    setCarEnvironment(env);
    old?.dispose();
  };

  let flooded = false;
  // The time of day: the circuit's own (TrackDef.light), or Day, Dusk or Night (the Time of day setting), or any look
  // by its id (?time=). The weather must be dry (Weather.dispose) while it changes: it is the weather's base.
  const setTime = (choice: TimeChoice | LightId) => {
    const look = lookFor(def.light, choice, def.scene === 'desert');
    stage.time = choice; stage.look = look;
    lightDir(look.sunElev, def.sunAz, sunDir);
    lx.crossVectors(UP, sunDir).normalize(); ly.crossVectors(sunDir, lx).normalize();
    sun.color.set(look.sun);
    lightBase(look, renderer.toneMappingExposure, stage.light);
    applyBase(stage);
    skyUniforms(look, sky.material, def.sunAz);
    scene.background = stage.light.fog;
    if (look.flood < 1 && !flooded) {
      // the floodlights reach 25 m beyond the walls, then fade out over 110 m
      const m = floodMap(track.X, track.Z, (i) => Math.max(track.barL[i], track.barR[i]) + 25);
      flood.uFloodMap.value = m.tex; flood.uFloodBox.value.copy(m.box);
      flooded = true;
    }
    flood.uFloodDark.value = look.flood;
    glow.set(look.lamps);
    // floodlight masts: at dusk and night, and always at a circuit raced at night (they stand there by day too)
    trackside.setLamps(look.lamps > 0 || LOOKS[def.light].phase !== 'day');
    useEnv(makeEnv(look));
  };

  // (weather.ts changes the sky, lights, fog and these materials while it rains or the track is wet, from `light`)
  const surfaces = { ...trackMaterials, terrain };
  const stage = {
    renderer, scene, camera, sky, sun, sunDir, hemi, env: null as THREE.Texture | null, surfaces, followSun, bounds, brakeMarkers, trackside,
    look: LOOKS.clear as Look, time, light: lightBase(LOOKS.clear),
    setResolution, setShadows, setBrightness, setDetail, setTime,
  };
  setTime(time);
  return stage;
}
export type Stage = ReturnType<typeof buildStage>;
