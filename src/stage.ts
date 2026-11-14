import * as THREE from 'three';
import { buildBrakeMarkers } from './brakeMarkers';
import { setCarEnvironment } from './carMeshes';
import { buildScenery, buildSky } from './scenery';
import type { Track } from './track';
import type { TrackDef } from './tracks';
import { buildTrackMeshes } from './trackMeshes';

// ============================================================================
// Renderer, scene, lights and everything static around the circuit
// ============================================================================
const SHADOW_HALF = 60, SHADOW_AHEAD = 28, SHADOW_MAP = 2048, SUN_DIST = 250;

export function buildStage(canvas: HTMLCanvasElement, track: Track, def: TrackDef) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const horizon = new THREE.Color(0.80, 0.87, 0.93);   // matches sky shader horizon (display space)
  scene.fog = new THREE.FogExp2(new THREE.Color().setRGB(0.80, 0.87, 0.93, THREE.SRGBColorSpace), 0.00042);
  scene.background = horizon;
  const camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.1, 9000);

  const sunDir = new THREE.Vector3(-0.45, 0.62, 0.35).normalize();
  const sky = buildSky(scene, sunDir);
  // Blurred sky-and-ground environment for car paint, glass and rims (cars only; the circuit keeps its lighting).
  {
    const envScene = new THREE.Scene(), pmrem = new THREE.PMREMGenerator(renderer);
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), sky.material));
    const ground = new THREE.Mesh(new THREE.CircleGeometry(45, 32), new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(0.16, 0.2, 0.13) }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -2;
    envScene.add(ground);
    setCarEnvironment(pmrem.fromScene(envScene, 0.02).texture);
    pmrem.dispose(); ground.geometry.dispose(); ground.material.dispose();
  }
  scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x5a6a40, 1.1));
  const sun = new THREE.DirectionalLight(0xfff1dc, 3.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  Object.assign(sun.shadow.camera, { left: -SHADOW_HALF, right: SHADOW_HALF, top: SHADOW_HALF, bottom: -SHADOW_HALF, near: SUN_DIST - 120, far: SUN_DIST + 120 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  // Light-space axes, for snapping the shadow camera to whole shadow-map texels: without it, shadow edges crawl
  // as the car moves.
  const lx = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), sunDir).normalize();
  const ly = new THREE.Vector3().crossVectors(sunDir, lx).normalize();
  const texel = (2 * SHADOW_HALF) / SHADOW_MAP, centre = new THREE.Vector3();
  // Centre the shadow map a little ahead of the view (where shadows are seen), snapped to texels.
  const followSun = (p: THREE.Vector3, viewDir: THREE.Vector3) => {
    const h = Math.hypot(viewDir.x, viewDir.z) || 1;
    centre.set(p.x + (viewDir.x / h) * SHADOW_AHEAD, p.y, p.z + (viewDir.z / h) * SHADOW_AHEAD);
    const a = Math.round(centre.dot(lx) / texel) * texel, b = Math.round(centre.dot(ly) / texel) * texel, c = centre.dot(sunDir);
    centre.copy(lx).multiplyScalar(a).addScaledVector(ly, b).addScaledVector(sunDir, c);
    sun.target.position.copy(centre);
    sun.position.copy(centre).addScaledVector(sunDir, SUN_DIST);
  };

  buildTrackMeshes(track, scene);
  const bounds = buildScenery(track, scene, def);
  const brakeMarkers = buildBrakeMarkers(track, scene);

  // Also catches devicePixelRatio changes (browser zoom, moving the window to another monitor).
  addEventListener('resize', () => {
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  });

  return { renderer, scene, camera, sky, sun, sunDir, followSun, bounds, brakeMarkers };
}
export type Stage = ReturnType<typeof buildStage>;
