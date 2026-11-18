// Weather visuals and sound (weather.ts, rain.ts, spray.ts, weatherAudio.ts) without a GPU: the mapping from rain
// and wetness, the dev flags, the fog colour that tone-maps to the sky's, and that the Weather builds nothing while
// dry, builds what the weather needs, and undoes and frees all of it when both are back at 0.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CARS } from '../src/cars';
import { S_ASPHALT, S_GRASS } from '../src/config';
import { buildSky } from '../src/scenery';
import { applyBase, lightBase, LOOKS, type LightId } from '../src/timeOfDay';
import type { Vehicle } from '../src/vehicle';
import { FOG_DENSITY, fogForDisplay, toneMap, Weather, weatherFromUrl, weatherLook, type WeatherStage } from '../src/weather';
import { weatherSound } from '../src/weatherAudio';

describe('weatherLook', () => {
  it('is the dry look at 0/0', () => {
    const l = weatherLook(0, 0);
    expect(l).toMatchObject({ overcast: 0, sun: 1, hemi: 1, fogDensity: FOG_DENSITY, wet: 0, puddles: 0, spray: 0, rain: 0 });
    expect(l.fog).toEqual([0.80, 0.87, 0.93]);
    expect(l.mist).toEqual(l.fog);
  });
  it('starts from the time of day: its horizon dry, its greys under cloud, spray lit by floodlights at night', () => {
    const night = lightBase(LOOKS.night);
    expect(weatherLook(0, 0, undefined, night).fog).toEqual(LOOKS.night.horizon);
    const wet = weatherLook(1, 1, undefined, night);
    for (let k = 0; k < 3; k++) {
      expect(wet.fog[k]).toBeCloseTo(LOOKS.night.rainFog[k], 6);
      expect(wet.fog[k]).toBeLessThan(0.25);                                       // a dark night, also in the rain
      expect(wet.mist[k]).toBeGreaterThan(wet.fog[k] + 0.15);                      // the spray shows under the lights
    }
    expect(weatherLook(1, 1, undefined, lightBase(LOOKS.clear))).toEqual(weatherLook(1, 1));
  });
  it('keeps rain (sky, light, fog) and wetness (road, spray) apart', () => {
    const wetOnly = weatherLook(0, 1), rainOnly = weatherLook(1, 0);
    expect(wetOnly).toMatchObject({ overcast: 0, sun: 1, fogDensity: FOG_DENSITY, wet: 1, puddles: 1, spray: 1 });
    expect(rainOnly).toMatchObject({ overcast: 1, sun: 0, wet: 0, puddles: 0, spray: 0, rain: 1 });
  });
  it('greys over in light rain and thickens the fog with more', () => {
    const light = weatherLook(0.3, 0.3), heavy = weatherLook(1, 1);
    expect(light.overcast).toBeGreaterThan(0.9);
    expect(light.sun).toBeLessThan(0.01);
    expect(heavy.fogDensity).toBeGreaterThan(2.5 * light.fogDensity);
    expect(heavy.fog[0]).toBeLessThan(light.fog[0]);
    // a downpour still leaves a few hundred metres: half the light gets through 250 m
    expect(Math.exp(-((heavy.fogDensity * 250) ** 2))).toBeGreaterThan(0.4);
  });
  it('looks damp at 0.3 (no puddles, little spray) and has standing water only near 1', () => {
    const damp = weatherLook(0, 0.3);
    expect(damp.wet).toBeGreaterThan(0.6);
    expect(damp.puddles).toBe(0);
    expect(damp.spray).toBeLessThan(0.2);
    expect(weatherLook(0, 0.9).puddles).toBeGreaterThan(0.7);
  });
  it('clamps', () => { expect(weatherLook(5, -1)).toEqual(weatherLook(1, 0)); });
});

describe('weatherFromUrl', () => {
  const p = (q: string) => weatherFromUrl(new URLSearchParams(q));
  it('reads ?rain and ?wet', () => {
    expect(p('')).toBeNull();
    expect(p('rain=0.7&wet=0.5')).toEqual({ rain: 0.7, wetness: 0.5 });
    expect(p('rain')).toEqual({ rain: 1, wetness: 1 });          // bare: 1, and the road wet to match
    expect(p('wet=0.3')).toEqual({ rain: 0, wetness: 0.3 });
    expect(p('rain=2&wet=x')).toEqual({ rain: 1, wetness: 0 });
  });
});

describe('fog colour', () => {
  it('tone-maps to the display colour the sky uses', () => {
    for (const exposure of [0.7, 1, 1.3]) {
      for (const d of [[0.47, 0.5, 0.54], [0.66, 0.7, 0.74], [0.8, 0.87, 0.93]]) {
        const c = fogForDisplay(d, exposure, new THREE.Color());
        const shown = toneMap([c.r, c.g, c.b], exposure);
        for (let k = 0; k < 3; k++) expect(shown[k]).toBeCloseTo(d[k], 2);
      }
    }
  });
});

describe('weatherSound', () => {
  it('is silent dry, hisses with speed on a wet road, swishes only in standing water', () => {
    expect(weatherSound(0, 0, 80, 1)).toMatchObject({ rain: 0, patter: 0, hiss: 0, swish: 0 });
    const slow = weatherSound(0, 0.5, 10, 1), fast = weatherSound(0, 0.5, 70, 1);
    expect(fast.hiss).toBeGreaterThan(5 * slow.hiss);
    expect(fast.swish).toBe(0);
    expect(weatherSound(0, 1, 70, 1).swish).toBeGreaterThan(0.9);
    expect(weatherSound(0, 1, 70, 0).hiss).toBe(0);                  // all four wheels on grass or gravel
    expect(weatherSound(0, 1, 0, 1).hiss).toBe(0);                   // standing still
    expect(weatherSound(1, 0, 0, 1)).toMatchObject({ rain: 1, patter: 1, hiss: 0 });
    expect(fast.hissHz).toBeGreaterThan(slow.hissHz);
  });
});

// A stage as stage.ts builds it, without a renderer (so no reflection maps), and the player's car, at a time of day.
function fakeStage(time: LightId = 'clear') {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(new THREE.Color().setRGB(0.80, 0.87, 0.93, THREE.SRGBColorSpace), FOG_DENSITY);
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 9000);
  const sky = buildSky(scene, new THREE.Vector3(0, 1, 0));
  const sun = new THREE.DirectionalLight(0xffffff, 3), hemi = new THREE.HemisphereLight(0xcfe3ff, 0x5a6a40, 1.1);
  const m = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(p);
  const roadMat = m({ roughness: 0.92 });
  const road = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), roadMat), laneRoad = new THREE.Mesh(new THREE.PlaneGeometry(4, 10), roadMat);
  scene.add(sun, hemi, road, laneRoad);
  const surfaces = { road, laneRoads: [laneRoad], roadMat, lineMat: m({ color: 0xf4f4f0, roughness: 0.7 }), kerbMat: m({ roughness: 0.6 }), gravelMat: m({ roughness: 1 }), wallMat: m({ roughness: 0.85 }), terrain: m({ roughness: 1 }) };
  const stage: WeatherStage = { renderer: null, scene, camera, sky, sun, hemi, env: null, surfaces, light: lightBase(LOOKS[time]) };
  applyBase(stage);
  const spec = CARS.lcf1, mesh = spec.mesh(spec);
  scene.add(mesh.root);
  const wheels = [0, 1, 2, 3].map((k) => ({ grounded: true, surf: k === 0 ? S_GRASS : S_ASPHALT, out: false, slip: 0, contact: { x: k, y: 0, z: 0 } }));
  const car = { spec, mesh, wheels, vel: new THREE.Vector3(0, 0, 60), speedF: 60 } as unknown as Vehicle;
  return { stage, car, cars: { car, others: [] }, cam: { mode: 'driver', lookBack: false } };
}
const snapshot = (st: WeatherStage) => ({
  children: [...st.scene.children], fog: (st.scene.fog as THREE.FogExp2).color.getHex(), density: (st.scene.fog as THREE.FogExp2).density,
  sun: st.sun.intensity, hemi: st.hemi.intensity, hemiColor: st.hemi.color.getHex(), hemiGround: st.hemi.groundColor.getHex(), road: st.surfaces.road.material, lane: st.surfaces.laneRoads?.map((r) => r.material),
  colors: Object.values(st.surfaces).filter((m) => m instanceof THREE.MeshStandardMaterial).map((m) => [m.color.getHex(), m.roughness, m.envMap]),
  sky: { ...st.sky.material.defines }, layers: st.camera.layers.mask,
});

describe('Weather', () => {
  it('builds nothing and changes nothing while dry', () => {
    const { stage, cars, cam } = fakeStage(), before = snapshot(stage);
    const w = new Weather(stage);
    for (let k = 0; k < 10; k++) w.update(1 / 60, cam, cars);
    w.set({ rain: 0, wetness: 0 });
    for (let k = 0; k < 10; k++) w.update(1 / 60, cam, cars);
    expect(w.parts).toBeNull();
    expect(snapshot(stage)).toEqual(before);
  });

  it('builds what the weather needs, scaled by the setting, and undoes and frees all of it when dry again', () => {
    const { stage, cars, cam } = fakeStage(), before = snapshot(stage);
    const sound = { weather: { rain: 0, wetness: 0 } };
    const w = new Weather(stage, sound);
    const disposed: string[] = [];
    w.set({ rain: 1, wetness: 1 });
    for (let k = 0; k < 30; k++) w.update(1 / 60, cam, cars);
    expect(w.state).toEqual({ rain: 1, wetness: 1 });   // the first set is shown at once
    expect(sound.weather).toEqual({ rain: 1, wetness: 1 });
    expect(w.parts).toEqual({ streaks: true, lens: true, spray: true, wetRoad: true, envMaps: 0 });
    expect(stage.surfaces.road.material).not.toBe(stage.surfaces.roadMat);
    expect(stage.surfaces.laneRoads![0].material).toBe(stage.surfaces.road.material);   // (the pit lane's road wet with it)
    expect(stage.sky.material.defines.WEATHER).toBe('');
    expect(stage.sun.intensity).toBe(0);
    expect(stage.camera.layers.isEnabled(1)).toBe(true);
    const names = stage.scene.children.map((o) => o.name);
    expect(names).toEqual(expect.arrayContaining(['rain', 'spray', 'lensDrops']));
    for (const o of stage.scene.children) {
      if (o instanceof THREE.Mesh && ['rain', 'spray', 'lensDrops'].includes(o.name)) {
        o.geometry.addEventListener('dispose', () => disposed.push(o.name + ' geometry'));
        (o.material as THREE.Material).addEventListener('dispose', () => disposed.push(o.name + ' material'));
      }
    }
    (stage.surfaces.road.material as THREE.Material).addEventListener('dispose', () => disposed.push('wet road'));

    // the spray comes from the wheels on the asphalt (the first is on grass)
    const spray = stage.scene.getObjectByName('spray') as THREE.Mesh<THREE.InstancedBufferGeometry>;
    expect(spray.visible).toBe(true);

    // Reduced: fewer streaks, no lens drops
    w.quality = 'reduced';
    w.update(1 / 60, cam, cars);
    expect(w.parts).toMatchObject({ streaks: true, lens: false, spray: true });
    expect(stage.camera.layers.isEnabled(1)).toBe(false);
    expect((stage.scene.getObjectByName('rain') as THREE.Mesh<THREE.InstancedBufferGeometry>).geometry.instanceCount).toBe(3500);
    // Off: no particles, but the sky and road still show the weather
    w.quality = 'off';
    w.update(1 / 60, cam, cars);
    expect(w.parts).toMatchObject({ streaks: false, lens: false, spray: false, wetRoad: true });
    expect(stage.sky.material.defines.WEATHER).toBe('');
    w.quality = 'full';
    w.update(1 / 60, cam, cars);

    // dry again: eased out over a few seconds, then everything back as it was
    w.set({ rain: 0, wetness: 0 });
    w.update(1, cam, cars);
    expect(w.parts).not.toBeNull();
    expect(w.state.rain).toBeGreaterThan(0);
    for (let k = 0; k < 60; k++) w.update(1, cam, cars);
    expect(w.parts).toBeNull();
    expect(snapshot(stage)).toEqual(before);
    expect(disposed).toEqual(expect.arrayContaining(['wet road', 'rain geometry', 'rain material', 'spray geometry', 'spray material', 'lensDrops geometry', 'lensDrops material']));
    expect(sound.weather).toEqual({ rain: 0, wetness: 0 });
  });

  for (const time of ['night', 'dusk'] as const) {
    it(`rain at ${time}: the weather works on the time of day and puts it back exactly when dry`, () => {
      const { stage, cars, cam } = fakeStage(time), before = snapshot(stage);
      const w = new Weather(stage);
      w.set({ rain: 1, wetness: 1 });
      for (let k = 0; k < 5; k++) w.update(1 / 60, cam, cars);
      expect(w.parts).toMatchObject({ streaks: true, spray: true, wetRoad: true });
      // the floodlights shine on in the rain; the sun at dusk goes behind the cloud
      expect(stage.sun.intensity).toBe(time === 'night' ? LOOKS.night.sunIntensity : 0);
      const fog = (stage.scene.fog as THREE.FogExp2).color, hsl = { h: 0, s: 0, l: 0 };
      fog.getHSL(hsl);
      expect(hsl.l).toBeLessThan(time === 'night' ? 0.05 : 0.2);                  // (linear) a dark fog after dark
      expect(stage.sky.material.uniforms.uFog.value.r).toBeCloseTo(w.look.fog[0], 6);
      w.set({ rain: 0, wetness: 0 });
      for (let k = 0; k < 60; k++) w.update(1, cam, cars);
      expect(w.parts).toBeNull();
      expect(snapshot(stage)).toEqual(before);
    });
  }

  it('follows the time of day changing under it, and restores the new one', () => {
    const { stage, cars, cam } = fakeStage('clear');
    const w = new Weather(stage);
    w.set({ rain: 0.6, wetness: 0.6 });
    w.update(1 / 60, cam, cars);
    // the setting changes: the game drops the weather, changes the base, and the weather builds again on it
    w.dispose();
    lightBase(LOOKS.night, 1, stage.light); applyBase(stage);
    const night = snapshot(stage);
    w.update(1 / 60, cam, cars);
    expect(stage.sun.intensity).toBe(LOOKS.night.sunIntensity);
    w.set({ rain: 0, wetness: 0 });
    for (let k = 0; k < 60; k++) w.update(1, cam, cars);
    expect(snapshot(stage)).toEqual(night);
  });

  it('a damp track under a clear sky: wet road, no rain, the dry sky', () => {
    const { stage, cars, cam } = fakeStage(), fog = (stage.scene.fog as THREE.FogExp2).color.getHex(), sun = stage.sun.intensity;
    const w = new Weather(stage);
    w.set({ rain: 0, wetness: 0.3 });
    w.update(1 / 60, cam, cars);
    expect(w.parts).toMatchObject({ streaks: false, lens: false, spray: true, wetRoad: true });
    expect(stage.sky.material.defines?.WEATHER).toBeUndefined();
    expect((stage.scene.fog as THREE.FogExp2).color.getHex()).toBe(fog);
    expect(stage.sun.intensity).toBe(sun);
    w.dispose();
    expect(stage.surfaces.road.material).toBe(stage.surfaces.roadMat);
  });
});
