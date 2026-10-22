import * as THREE from 'three';
import { buildBrakeMarkers } from './brakeMarkers';
import { buildScenery, buildSky } from './scenery';
import type { Track } from './track';
import { buildTrackMeshes } from './trackMeshes';

// ============================================================================
// Renderer, scene, lights and everything static around the circuit
// ============================================================================
export function buildStage(canvas: HTMLCanvasElement, track: Track) {
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
  scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x5a6a40, 1.1));
  const sun = new THREE.DirectionalLight(0xfff1dc, 3.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 600 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  buildTrackMeshes(track, scene);
  const bounds = buildScenery(track, scene);
  const brakeMarkers = buildBrakeMarkers(track, scene);

  addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });

  return { renderer, scene, camera, sky, sun, sunDir, bounds, brakeMarkers };
}
export type Stage = ReturnType<typeof buildStage>;
