import type * as THREE from 'three';
import { setCarModelSource } from './carMeshes';

// ============================================================================
// Loads the car model files (public/cars/<id>/model.glb) for carMeshes.ts: once each, kept for the session, so
// switching back to a car reuses it. Browser only (the stage installs it); in Node cars keep their built bodies.
// The loader itself (GLTFLoader, meshopt decoder) is a chunk of its own, fetched with the first model.
// ============================================================================

// Content hashes of the model files (vite.config.ts), in the URL so a changed model is never served from a cache.
declare const __CAR_MODELS__: Record<string, string>;

let gltfLoader: Promise<{ loadAsync(url: string): Promise<{ scene: THREE.Group }> }> | null = null;
const loaded = new Map<string, Promise<THREE.Object3D>>();

function loader() {
  gltfLoader ??= Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/libs/meshopt_decoder.module.js'),
  ]).then(([{ GLTFLoader }, { MeshoptDecoder }]) => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder));
  gltfLoader.catch(() => { gltfLoader = null; });
  return gltfLoader;
}

function loadCarModel(url: string): Promise<THREE.Object3D> {
  let p = loaded.get(url);
  if (!p) {
    const v = __CAR_MODELS__[url];
    p = loader().then((l) => l.loadAsync(v ? `${url}?v=${v}` : url)).then((gltf) => gltf.scene);
    p.catch(() => loaded.delete(url));   // a failed download is tried again the next time the car is built
    loaded.set(url, p);
  }
  return p;
}

export function installCarModels() { setCarModelSource(loadCarModel); }
