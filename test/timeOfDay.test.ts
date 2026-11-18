// Time of day (timeOfDay.ts) without a GPU: every circuit's light, the setting and the URL flag, the fog colour that
// tone-maps to each look's horizon, the floodlights' reach and the glow of lamps and windows.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildSky } from '../src/scenery';
import { applyBase, floodMap, fogForDisplay, Glow, lightBase, lightDir, lookFor, LOOKS, skyUniforms, timeFromUrl, toneMap, type LightId } from '../src/timeOfDay';
import { TRACKS } from '../src/tracks';

describe('time of day', () => {
  it('races each circuit at its Grand Prix\'s time: five at night, Yas Marina at dusk, the rest by day', () => {
    const by = (phase: string) => Object.values(TRACKS).filter((t) => LOOKS[t.light].phase === phase).map((t) => t.id).sort();
    expect(by('night')).toEqual(['bahrain', 'jeddah', 'lasvegas', 'lusail', 'singapore']);
    expect(by('dusk')).toEqual(['yasmarina']);
    expect(by('day')).toHaveLength(18);
    // the day races do not all share one sky
    const days = new Set(Object.values(TRACKS).filter((t) => LOOKS[t.light].phase === 'day').map((t) => t.light));
    expect(days.size).toBeGreaterThanOrEqual(5);
    for (const t of Object.values(TRACKS)) expect(t.sunAz).toBeGreaterThanOrEqual(0), expect(t.sunAz).toBeLessThan(360);
  });

  it('lets the setting show any circuit by day, at dusk or at night', () => {
    expect(lookFor('golden', 'circuit').id).toBe('golden');
    expect(lookFor('golden', 'day').id).toBe('golden');               // a day race keeps its own day
    expect(lookFor('night', 'day').id).toBe('clear');                 // a night race by day
    expect(lookFor('night', 'day', true).id).toBe('desert');          // ...in the desert
    expect(lookFor('clear', 'night').id).toBe('night');
    expect(lookFor('clear', 'dusk').id).toBe('dusk');
    expect(lookFor('clear', 'haze').id).toBe('haze');                 // ?time= also takes a look's id
  });

  it('reads ?time', () => {
    const p = (q: string) => timeFromUrl(new URLSearchParams(q));
    expect(p('')).toBeNull();
    expect(p('time=night')).toBe('night');
    expect(p('time=golden')).toBe('golden');
    expect(p('time=noon')).toBeNull();
  });

  it('puts the sun where the look says', () => {
    const d = lightDir(30, 90);                                        // 30 deg up, due east (+x)
    expect(d.y).toBeCloseTo(0.5, 6); expect(d.x).toBeCloseTo(Math.cos(Math.PI / 6), 6); expect(d.z).toBeCloseTo(0, 6);
    expect(lightDir(10, 0).z).toBeLessThan(0);                         // north is -z
  });

  it('gives a fog colour that tone-maps to every look\'s horizon, at every Brightness', () => {
    for (const look of Object.values(LOOKS)) {
      for (const exposure of [0.7, 1, 1.3]) {
        const c = fogForDisplay(look.horizon, exposure, new THREE.Color());
        const shown = toneMap([c.r, c.g, c.b], exposure);
        for (let k = 0; k < 3; k++) expect(shown[k], `${look.id} at ${exposure}`).toBeCloseTo(look.horizon[k], 2);
      }
    }
  });

  it('applies a look to the lights, fog and sky, and keeps night easy to drive', () => {
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0xffffff, 0.001);
    const sky = buildSky(scene, new THREE.Vector3(0, 1, 0));
    const st = { scene, sky, sun: new THREE.DirectionalLight(), hemi: new THREE.HemisphereLight(), light: lightBase(LOOKS.night) };
    applyBase(st);
    skyUniforms(LOOKS.night, sky.material, 200);
    expect(st.sun.intensity).toBe(LOOKS.night.sunIntensity);
    expect((scene.fog as THREE.FogExp2).color.getHex()).toBe(st.light.fog.getHex());
    expect(sky.material.uniforms.uStars.value).toBe(1);
    // floodlit: the light on the track is within reach of the day's (the road stays as readable)
    const lit = (id: LightId) => LOOKS[id].sunIntensity * Math.sin((LOOKS[id].sunElev * Math.PI) / 180) + LOOKS[id].hemiIntensity;
    expect(lit('night')).toBeGreaterThan(0.75 * lit('clear'));
    expect(LOOKS.night.flood).toBeLessThan(0.3);                       // ...and dark beyond it
    expect(LOOKS.night.cloudHidesKey).toBe(0);                         // floodlights shine through the rain
  });

  it('floodlights the circuit and leaves the country beyond it dark', () => {
    // a straight 1 km road along x
    const X = Array.from({ length: 501 }, (_, i) => i * 2), Z = X.map(() => 0);
    const { tex, box } = floodMap(X, Z, () => 20, 100);
    const at = (x: number, z: number) => {
      const img = tex.image as { data: Uint8Array; width: number; height: number };
      const u = Math.floor((x - box.x) * box.z * img.width), v = Math.floor((z - box.y) * box.w * img.height);
      return img.data[(v * img.width + u) * 4] / 255;
    };
    expect(at(500, 0)).toBe(1);
    expect(at(500, 15)).toBe(1);
    expect(at(500, 70)).toBeGreaterThan(0.2);
    expect(at(500, 70)).toBeLessThan(0.8);
    expect(at(500, 150)).toBe(0);
  });

  it('lights lamps and windows with the look', () => {
    const g = new Glow(), lamp = new THREE.MeshStandardMaterial(), sign = new THREE.MeshBasicMaterial({ color: 0x804020 }), halo = new THREE.PointsMaterial();
    g.add(lamp, 3); g.add(sign, 1.5, 0.5); g.add(halo, 1);
    g.set(0);
    expect(lamp.emissiveIntensity).toBe(0); expect(sign.color.getHex()).toBe(new THREE.Color(0x804020).multiplyScalar(0.5).getHex()); expect(halo.visible).toBe(false);
    g.set(1);
    expect(lamp.emissiveIntensity).toBe(3); expect(halo.visible).toBe(true);
  });
});
