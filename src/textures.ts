import * as THREE from 'three';
import { clamp } from './util';

// ============================================================================
// Procedural textures
// ============================================================================
type Draw = (g: CanvasRenderingContext2D, w: number, h: number) => void;

export function canvasTex(w: number, h: number, draw: Draw, { srgb = true, repeat = true, nearest = false } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d')!; draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (nearest) { t.magFilter = THREE.NearestFilter; }
  t.anisotropy = 8;
  return t;
}
export function noiseFill(g: CanvasRenderingContext2D, w: number, h: number, base: [number, number, number], amp: number, speck = 0) {
  const img = g.createImageData(w, h), d = img.data;
  for (let i = 0; i < w * h; i++) {
    const n = (Math.random() - 0.5) * amp + (Math.random() < speck ? (Math.random() - 0.3) * amp * 3 : 0);
    d[i * 4] = clamp(base[0] + n, 0, 255); d[i * 4 + 1] = clamp(base[1] + n, 0, 255); d[i * 4 + 2] = clamp(base[2] + n, 0, 255); d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}
