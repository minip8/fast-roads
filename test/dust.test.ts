import * as THREE from 'three';
import { expect, test } from 'vitest';
import { keepOut } from '../src/dust';

// Dust puffs are kept out of the car's body (its box in the car's frame, grown by a margin).
const box = new THREE.Box3(new THREE.Vector3(-1, 0, -2.5), new THREE.Vector3(1, 1.2, 2.5));

test('a puff at a wheel leaves through its own side', () => {
  const left = new THREE.Vector3(0.8, 0.05, 1.6), right = new THREE.Vector3(-0.8, 0.05, -1.6);
  expect(keepOut(left, box, 0.3)).toBe(true);
  expect(left.toArray()).toEqual([1.3, 0.05, 1.6]);
  expect(keepOut(right, box, 0.3)).toBe(true);
  expect(right.toArray()).toEqual([-1.3, 0.05, -1.6]);
});

test('a puff the car runs into leaves through the nearest end', () => {
  const ahead = new THREE.Vector3(0.1, 0.5, 2.6), behind = new THREE.Vector3(0.1, 0.5, -2.7);
  expect(keepOut(ahead, box, 0.3)).toBe(true);
  expect(ahead.z).toBeCloseTo(2.8);
  expect(ahead.x).toBe(0.1);
  expect(keepOut(behind, box, 0.3)).toBe(true);
  expect(behind.z).toBeCloseTo(-2.8);
});

test('puffs clear of the body or above it are left alone', () => {
  for (const p of [[1.31, 0.1, 0], [0, 0.1, -2.81], [0, 1.6, 0], [-3, 0.5, 9]]) {
    const v = new THREE.Vector3(...p);
    expect(keepOut(v, box, 0.3)).toBe(false);
    expect(v.toArray()).toEqual(p);
  }
});
