// The cockpit's live instruments (src/cockpitDisplay.ts): what they show for a car's state, and their meshes. The
// drawing itself needs a canvas, which Node has not: the display must simply stay dark here.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CARS, type CarId } from '../src/cars';
import { blankValues, buildScreen, CockpitDisplay, dashValues, LAYOUTS, NONE, shiftLights } from '../src/cockpitDisplay';
import { session } from './harness';

describe('shift lights', () => {
  it('fill from shiftLightsFrom to the upshift point, and stay dark in reverse', () => {
    const spec = CARS.lcf1, n = 15, { shiftLightsFrom: from, shiftPoint: to } = spec;
    expect(shiftLights(spec, 3, from - 500, n)).toBe(0);
    expect(shiftLights(spec, 3, from, n)).toBe(0);
    expect(shiftLights(spec, 3, (from + to) / 2, n)).toBe(8);
    expect(shiftLights(spec, 3, to, n)).toBe(n);
    expect(shiftLights(spec, 3, to + 1000, n)).toBe(n);
    expect(shiftLights(spec, -1, to, n)).toBe(0);
  });
});

describe('dash values', () => {
  it.each(['lcf1', 'lcgt3', 'drift'] as CarId[])('%s: show what the HUD shows', async (id) => {
    const s = await session(id, { flying: true });
    s.drive(1.5);
    const { car, timing } = s, v = blankValues(), leds = LAYOUTS.f1.leds;
    dashValues(car, timing, s.session.simTime, 0, 'kmh', leds, 0, v);
    expect(v.gear).toBe(car.gear);
    expect(v.speed).toBe(Math.round(Math.abs(car.speedF) * 3.6));
    expect(v.rpm).toBe(Math.round(car.rpm / 50) * 50);
    expect(v.lights).toBe(shiftLights(car.spec, car.gear, car.rpm, leds));
    expect(v.lap).toBe(-1);                                   // the flying start's out lap
    expect(v.delta).toBe(NONE);
    expect(v.tc).toBeGreaterThanOrEqual(1);
    dashValues(car, timing, s.session.simTime, 0, 'mph', leds, 0, v);
    expect(v.speed).toBe(Math.round(Math.abs(car.speedF) * 2.236936));
    // only the 2026 F1 has a battery and movable flaps
    if (id === 'lcf1') { expect(v.battery).toBeGreaterThan(0); expect(v.battery).toBeLessThanOrEqual(100); expect([0, 1]).toContain(v.flaps); }
    else { expect(v.battery).toBe(-1); expect(v.flaps).toBe(-1); }
    car.tc = false;
    dashValues(car, timing, s.session.simTime, 0, 'kmh', leds, 0, v);
    expect(v.tc).toBe(0);
    // the lap clock runs once the line is crossed
    s.drive(3, null, () => timing.lapStart != null);
    s.drive(1);
    dashValues(car, timing, s.session.simTime, 0, 'kmh', leds, 0, v);
    expect(v.lap).toBe(Math.floor((s.session.simTime - timing.lapStart!) * 10));
    expect(v.lapNo).toBe(1);
  }, 30000);
});

describe('display meshes', () => {
  it('every car has a screen in its cockpit: the F1 and GT3 on the wheel, the drift car on the dash', () => {
    for (const [id, style, onWheel] of [['lcf1', 'f1', true], ['lcgt3', 'gt3', true], ['drift', 'cluster', false]] as const) {
      const spec = CARS[id], mesh = spec.mesh(spec), screen = mesh.cockpit.screen!;
      expect(screen.style).toBe(style);
      let p: THREE.Object3D | null = screen.mesh;
      while (p && p !== mesh.cockpit.wheel) p = p.parent;
      expect(!!p, id).toBe(onWheel);
      mesh.dispose();
    }
  });

  it('maps the screen and the LED strip onto their parts of the canvas', () => {
    const L = LAYOUTS.f1, H = L.ledH + L.h, uv = buildScreen('f1', { x: 0, y: 0, z: 0, w: 0.1, h: 0.05 }, { x: 0, y: 0.04, z: 0, w: 0.15, h: 0.01 }).mesh.geometry.attributes.uv;
    const vs = Array.from({ length: uv.count }, (_, k) => uv.getY(k));
    expect(Math.min(...vs.slice(0, 4))).toBeCloseTo(0, 6);             // screen: canvas bottom...
    expect(Math.max(...vs.slice(0, 4))).toBeCloseTo(L.h / H, 6);       // ...to the strip
    expect(Math.min(...vs.slice(4))).toBeCloseTo(L.h / H, 6);          // strip: the top rows
    expect(Math.max(...vs.slice(4))).toBeCloseTo(1, 6);
    const full = buildScreen('cluster', { x: 0, y: 0, z: 0, w: 0.1, h: 0.05 }, null).mesh.geometry.attributes.uv;
    expect(Math.max(...Array.from({ length: full.count }, (_, k) => full.getY(k)))).toBeCloseTo(1, 6);
  });

  it('stays dark without a canvas, and frees its own texture with the car', async () => {
    const s = await session('lcf1', { flying: true });
    const screen = s.car.mesh.cockpit.screen!;
    new CockpitDisplay().update(s.car, s.timing, s.session.simTime, 0, true);
    expect(screen.mesh.material.map).toBeNull();
    const tex = new THREE.Texture(), m = screen.mesh.material;
    tex.userData.owned = true; m.map = tex;
    let freed = false;
    tex.addEventListener('dispose', () => { freed = true; });
    s.session.setCar(CARS.drift);
    expect(freed).toBe(true);
  });
});
