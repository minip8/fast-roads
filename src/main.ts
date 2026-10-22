import * as THREE from 'three';
import trackCsv from '../tracks/melbourne.csv?raw';
import RAPIER from '@dimforge/rapier3d-compat';
import { EngineAudio } from './audio';
import { autopilot } from './autopilot';
import { buildBrakeMarkers } from './brakeMarkers';
import { Car, _v1, _v2, _v3, type DriveInput } from './car';
import { CARS, type CarId } from './cars';
import { DT, MAX_STEPS_PER_FRAME, SURF } from './config';
import { Dust } from './dust';
import { Input, MOUSE_DEADZONE, MOUSE_RANGE, type MouseDeadzone, type MouseSensitivity } from './input';
import { buildScenery, buildSky } from './scenery';
import { needsReset, stepPhysics } from './sim';
import { Timing } from './timing';
import { buildTrack, buildTrackColliders, parseCSV } from './track';
import { buildTrackMeshes } from './trackMeshes';
import { clamp, fmtDelta, fmtSec, fmtTime, wrapI } from './util';

// ============================================================================
// Main
// ============================================================================
// Page elements always exist (see index.html), so a missing one is a bug worth failing loudly on.
function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el as T;
}

const CAM_MODES = ['onboard', 'chase', 'far'] as const;   // first is the default; C cycles
type CamMode = (typeof CAM_MODES)[number];
type OnOff = 'on' | 'off';

interface Settings {
  car: CarId; gearbox: 'auto' | 'manual'; steering: 'keyboard' | 'mouse';
  mouseSens: MouseSensitivity; mouseDeadzone: MouseDeadzone; camera: CamMode; tc: OnOff; sound: OnOff;
}
type SettingKey = keyof Settings;
interface SettingDef<K extends SettingKey> { label: string; options: [value: Settings[K], text: string][] }

// Menu rows, in display order.
const SETTING_DEFS: { [K in SettingKey]: SettingDef<K> } = {
  car: { label: 'Car', options: Object.values(CARS).map((c) => [c.id, c.name]) },
  gearbox: { label: 'Gears', options: [['auto', 'Automatic'], ['manual', 'Manual']] },
  steering: { label: 'Steering', options: [['keyboard', 'Keyboard'], ['mouse', 'Mouse']] },
  mouseSens: { label: 'Mouse sensitivity', options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] },
  mouseDeadzone: { label: 'Mouse deadzone', options: [['off', 'Off'], ['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']] },
  camera: { label: 'Camera', options: [['onboard', 'Onboard'], ['chase', 'Chase'], ['far', 'Far']] },
  tc: { label: 'Traction control', options: [['on', 'On'], ['off', 'Off']] },
  sound: { label: 'Sound', options: [['on', 'On'], ['off', 'Off']] },
};
const SETTING_KEYS = Object.keys(SETTING_DEFS) as SettingKey[];
const DEFAULT_SETTINGS: Settings = {
  car: 'f1', gearbox: 'auto', steering: 'keyboard', mouseSens: 'medium', mouseDeadzone: 'small', camera: 'onboard', tc: 'on', sound: 'on',
};

// Test hook (see CLAUDE.md); set in main().
declare global { interface Window { __game?: unknown } }

async function main() {
  const params = new URLSearchParams(location.search);
  const overlay = $('overlay'), loadState = $('loadState');
  await RAPIER.init();
  loadState.textContent = 'Building circuit…';
  await new Promise((r) => setTimeout(r, 0));   // let the loading text paint

  const track = buildTrack(parseCSV(trackCsv));

  // Renderer / scene
  const canvas = $<HTMLCanvasElement>('view');
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

  // Physics
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  const wallCount = buildTrackColliders(track, world);
  let car = new Car(world, track, scene, CARS.f1);   // replaced when the Car setting changes
  const spawnS = track.L - 160;
  car.placeAt(spawnS, 0);
  const timing = new Timing(track, car.spec.storeKey);
  const input = new Input();
  const audio = new EngineAudio();
  const dust = new Dust(scene);

  // HUD
  $('trkLen').textContent = (track.L / 1000).toFixed(2) + ' km';
  const hud = { lap: $('lapTime'), state: $('lapState'), delta: $('delta'), last: $('lastLap'), best: $('bestLap'), opt: $('optLap'),
    list: $('lapList'), speed: $('speed'), gear: $('gear'), flags: $('flags'), msg: $('msg'), help: $('help'),
    sec: [0, 1, 2].map((k) => $('sec' + k)) };
  // Shift lights light up from the car's shiftLightsFrom to its auto-upshift point, then all flash.
  const lights: HTMLElement[] = [];
  for (let k = 0; k < 15; k++) { const d = document.createElement('i'); d.className = k < 5 ? 'g' : k < 10 ? 'r' : 'b'; $('shiftLights').append(d); lights.push(d); }
  let litCount = -1;
  const updateDash = () => {
    const n = car.gear === 0 ? 0 : Math.round(clamp((car.rpm - car.spec.shiftLightsFrom) / (car.spec.shiftPoint - car.spec.shiftLightsFrom), 0, 1) * 15);
    if (n !== litCount) { lights.forEach((d, k) => d.classList.toggle('on', k < n)); litCount = n; }
    const sl = $('shiftLights'), flashing = n === 15;
    sl.classList.toggle('flash', flashing);
    sl.classList.toggle('off', flashing && Math.floor(performance.now() / 70) % 2 === 1);
    $('thrFill').style.height = Math.round(clamp(car.throttle, 0, 1) * 100) + '%';
    $('brkFill').style.height = Math.round(clamp(car.brake, 0, 1) * 100) + '%';
  };
  let msgTimer = 0;
  const showMsg = (html: string, secs = 2.5) => { hud.msg.innerHTML = html; hud.msg.classList.add('show'); msgTimer = secs; };
  const renderLapList = () => {
    hud.list.innerHTML = timing.laps.slice(0, 6).map((l, k) =>
      `<div class="${l.valid ? (l.pb ? 'pb' : '') : 'inv'}"><span>L${timing.laps.length - k}</span><span>${fmtTime(l.time)}</span></div>`).join('');
  };

  // Minimap
  const mm = $<HTMLCanvasElement>('minimap'), mctx = mm.getContext('2d')!;
  const mmBase = document.createElement('canvas'); mmBase.width = mm.width; mmBase.height = mm.height;
  const pad = 30, span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
  const mmScale = (mm.width - pad * 2) / span;
  const mmX = (x: number) => pad + (x - bounds.minX) * mmScale + ((span - (bounds.maxX - bounds.minX)) * mmScale) / 2;
  const mmY = (z: number) => pad + (z - bounds.minZ) * mmScale + ((span - (bounds.maxZ - bounds.minZ)) * mmScale) / 2;
  {
    const g = mmBase.getContext('2d')!;
    g.lineJoin = 'round'; g.lineCap = 'round';
    const path = () => { g.beginPath(); for (let i = 0; i <= track.N; i++) { const k = i % track.N; i ? g.lineTo(mmX(track.X[k]), mmY(track.Z[k])) : g.moveTo(mmX(track.X[k]), mmY(track.Z[k])); } };
    path(); g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 12; g.stroke();
    path(); g.strokeStyle = '#e8ecf0'; g.lineWidth = 6; g.stroke();
    timing.lines.forEach((ln, k) => {
      g.beginPath(); g.moveTo(mmX(track.X[ln.i] - track.NX[ln.i] * 40), mmY(track.Z[ln.i] - track.NZ[ln.i] * 40));
      g.lineTo(mmX(track.X[ln.i] + track.NX[ln.i] * 40), mmY(track.Z[ln.i] + track.NZ[ln.i] * 40));
      g.strokeStyle = k === 0 ? '#ff4d4d' : '#ffd23f'; g.lineWidth = 4; g.stroke();
    });
  }

  // Camera rig
  let camMode = 0;
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), camFwd = new THREE.Vector3(0, 0, 1);
  let camInit = false;
  const updateCamera = (dt: number) => {
    const root = car.mesh.root, p = root.position;
    const fwd = _v1.set(0, 0, 1).applyQuaternion(root.quaternion);
    const mode = CAM_MODES[camMode];
    if (mode === 'onboard') {
      const upv = _v2.set(0, 1, 0).applyQuaternion(root.quaternion);
      const cam = car.spec.cam;
      camera.position.copy(p).addScaledVector(upv, cam.up).addScaledVector(fwd, -cam.back);
      camera.lookAt(_v3.copy(camera.position).addScaledVector(fwd, 10).addScaledVector(upv, -cam.down));
      camera.fov = 78;
    } else {
      const flat = _v2.set(fwd.x, 0, fwd.z).normalize();
      if (!camInit) { camFwd.copy(flat); camInit = true; }
      camFwd.lerp(flat, 1 - Math.exp(-dt * 7)).normalize();
      const dist = mode === 'far' ? 9.5 : 6.2, h = mode === 'far' ? 3.0 : 1.75;
      const target = _v3.copy(p).addScaledVector(camFwd, -dist); target.y = p.y + h;
      if (!camPos.lengthSq()) camPos.copy(target);
      camPos.lerp(target, 1 - Math.exp(-dt * 14));
      camera.position.copy(camPos);
      camLook.copy(p).addScaledVector(camFwd, 4); camLook.y = p.y + 0.6;
      camera.lookAt(camLook);
      camera.fov = 66 + clamp(car.speedF, 0, 90) * 0.12;
    }
    camera.updateProjectionMatrix();
    sky.position.copy(camera.position);
    sun.position.copy(p).addScaledVector(sunDir, 250);
    sun.target.position.copy(p);
  };

  // Game state
  // The autopilot is a development/testing tool: only ?autopilot in the URL (or the __game test hook) turns it on.
  let started = params.has('autopilot'), paused = false, autoOn = params.has('autopilot');
  let autoStuck = 0, simTime = 0, acc = 0, last = performance.now(), helpTimer = 14;

  const restart = () => { car.placeAt(spawnS, 0); timing.reset(); camInit = false; camPos.set(0, 0, 0); showMsg('Session restarted<small>Cross the line to start a lap</small>'); };
  const resetToTrack = () => {
    const s = car.proj.s;
    car.placeAt(s, 0);
    timing.invalidate('RESET');
    camInit = false; camPos.set(0, 0, 0);
  };

  addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });

  // ---------------- Settings (persisted) ----------------
  const SETTINGS_KEY = 'fastroads.settings';
  const settings: Settings = { ...DEFAULT_SETTINGS };
  try {
    // carry over choices saved by earlier versions (validated below)
    const g = localStorage.getItem('fastroads.gearbox'), st = localStorage.getItem('fastroads.steering');
    if (g) settings.gearbox = g as Settings['gearbox'];
    if (st) settings.steering = st as Settings['steering'];
    Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
  } catch { /* storage unavailable */ }
  const validate = <K extends SettingKey>(k: K) => {
    const opts = SETTING_DEFS[k].options;
    if (!opts.some(([v]) => v === settings[k])) settings[k] = opts[0][0];
  };
  SETTING_KEYS.forEach(validate);

  // What changing each setting does.
  const applySetting: { [K in SettingKey]: (v: Settings[K]) => void } = {
    car: (id) => {
      if (car.spec.id === id) return;
      car.destroy();
      car = new Car(world, track, scene, CARS[id]);
      car.manual = settings.gearbox === 'manual'; car.tc = settings.tc === 'on';
      car.placeAt(spawnS, 0);
      timing.useStore(car.spec.storeKey); timing.reset(); hud.list.innerHTML = '';
      camInit = false; camPos.set(0, 0, 0); acc = 0;
      if (id === 'drift') showMsg(`${car.spec.name}<small>Loose rear: brake while turning to kick it out · TC off (T) for big slides</small>`, 3);
    },
    gearbox: (v) => { car.manual = v === 'manual'; },
    steering: (v) => { input.setMouse(v === 'mouse'); $('mouseSteer').hidden = v !== 'mouse'; },
    mouseSens: (v) => { input.mouse.range = MOUSE_RANGE[v]; },
    mouseDeadzone: (v) => { input.mouse.deadzone = MOUSE_DEADZONE[v]; },
    camera: (v) => { camMode = Math.max(0, CAM_MODES.indexOf(v)); },
    tc: (v) => { car.tc = v === 'on'; },
    sound: (v) => { audio.setMuted(v === 'off'); },
  };
  const setSetting = <K extends SettingKey>(key: K, value: Settings[K]) => {
    settings[key] = value;
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
    applySetting[key](value);
    menu.refresh();
  };
  const cycleSetting = <K extends SettingKey>(key: K, dir = 1) => {
    const opts = SETTING_DEFS[key].options, i = opts.findIndex(([v]) => v === settings[key]);
    setSetting(key, opts[wrapI(i + dir, opts.length)][0]);
    return settings[key];
  };
  const resetBestTimes = () => {
    try { localStorage.removeItem(timing.storeKey); } catch { /* storage unavailable */ }
    timing.useStore(timing.storeKey);
    hud.list.innerHTML = '';
  };

  // ---------------- Main / pause menu ----------------
  interface MenuItem { el: HTMLElement; run?: () => void; setting?: SettingKey }
  interface Menu { isOpen: boolean; keyboardUsed: boolean; refresh(): void; open(): void; show(): void }
  const menu = ((): Menu => {
    const actionsEl = $('menuActions'), settingsEl = $('menuSettings'), resetEl = $('resetBest');
    let items: MenuItem[] = [], focus = 0, resetArmed = false;
    const api: Menu = { isOpen: true, keyboardUsed: false, refresh: () => {}, open: () => {}, show: () => {} };
    const close = () => {
      api.isOpen = false; overlay.classList.add('hidden');
      started = true; paused = false; $('hud').hidden = false; audio.start();
      input.pressed.clear();                       // the key that closed the menu shouldn't also act in-game
      input.mouse.lmb = input.mouse.rmb = false;   // the click that closed the menu isn't throttle
    };
    const actions = (): [label: string, run: () => void, primary?: boolean][] => !started
      ? [['Drive', () => close(), true]]
      : [['Resume', () => close(), true],
         ['Restart session', () => { restart(); close(); }]];
    const render = () => {
      items = [];
      actionsEl.innerHTML = '';
      for (const [label, run, primary] of actions()) {
        const bt = document.createElement('button');
        bt.type = 'button'; bt.className = 'mbtn' + (primary ? ' primary' : ''); bt.textContent = label;
        bt.addEventListener('click', run);
        actionsEl.append(bt);
        items.push({ el: bt, run });
      }
      settingsEl.innerHTML = '';
      const addRow = <K extends SettingKey>(key: K) => {
        const d = SETTING_DEFS[key];
        const row = document.createElement('div'); row.className = 'mrow';
        const lab = document.createElement('span'); lab.textContent = d.label;
        const seg = document.createElement('div'); seg.className = 'seg';
        for (const [v, text] of d.options) {
          const bt = document.createElement('button');
          bt.type = 'button'; bt.textContent = text; bt.className = settings[key] === v ? 'on' : '';
          bt.addEventListener('click', () => setSetting(key, v));
          seg.append(bt);
        }
        row.append(lab, seg); settingsEl.append(row);
        items.push({ el: row, setting: key });
      };
      SETTING_KEYS.forEach(addRow);
      items.push({ el: resetEl, run: () => onReset() });
      focus = clamp(focus, 0, items.length - 1);
      items.forEach((it, k) => it.el.classList.toggle('focus', k === focus && api.keyboardUsed));
      const best = timing.store.bestLap;
      $('menuBest').innerHTML = best != null ? `Best lap <b>${fmtTime(best)}</b>` : 'No best lap yet';
      resetEl.textContent = resetArmed ? 'Click again to reset' : 'Reset best times';
      resetEl.classList.toggle('armed', resetArmed);
      resetEl.hidden = best == null && !resetArmed;
    };
    const onReset = () => {
      if (!resetArmed) { resetArmed = true; render(); setTimeout(() => { resetArmed = false; if (api.isOpen) render(); }, 3000); return; }
      resetArmed = false; resetBestTimes(); render();
    };
    resetEl.addEventListener('click', onReset);
    api.refresh = () => { if (api.isOpen) render(); };
    api.open = () => {
      if (api.isOpen) return;
      api.isOpen = true; paused = true; focus = 0; resetArmed = false;
      overlay.classList.remove('hidden');
      render();
    };
    api.show = () => { $('loadState').hidden = true; $('menuBody').hidden = false; render(); };
    addEventListener('keydown', (e) => {
      if (!api.isOpen || $('menuBody').hidden) return;
      const it = items[focus];
      const nav = ({ ArrowUp: -1, ArrowDown: 1 } as Record<string, number>)[e.code];
      if (nav) { api.keyboardUsed = true; do { focus = wrapI(focus + nav, items.length); } while (items[focus].el.hidden); render(); e.preventDefault(); return; }
      if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && it?.setting) { api.keyboardUsed = true; cycleSetting(it.setting, e.code === 'ArrowLeft' ? -1 : 1); e.preventDefault(); return; }
      if (e.code === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        if (it?.setting) cycleSetting(it.setting, 1); else if (it?.run) it.run();
        return;
      }
      if (e.code === 'Escape' && started && !e.repeat) close();
    });
    return api;
  })();

  for (const k of SETTING_KEYS) setSetting(k, settings[k]);   // apply saved choices
  if (started) { menu.isOpen = false; overlay.classList.add('hidden'); $('hud').hidden = false; }   // ?autopilot skips the menu
  else menu.show();

  function physicsTick(inp: DriveInput) {
    stepPhysics(world, car, timing, inp, simTime);
    simTime += DT;
    // autopilot gets stuck against a wall: put it back on track
    autoStuck = autoOn && Math.abs(car.speedF) < 1 ? autoStuck + DT : 0;
    if (autoStuck > 3) { autoStuck = 0; resetToTrack(); }
    if (needsReset(car)) resetToTrack();
  }

  // Test hook: run the simulation headless (no rendering), e.g. __game.simulate(90, true)
  type Driver = boolean | ((car: Car, simTime: number) => DriveInput);   // true = autopilot, false = live input
  const simulate = (seconds: number, auto: Driver = true, probe: number | null = null) => {
    const wasAuto = autoOn; autoOn = auto === true;
    const n = Math.round(seconds / DT), log = [];
    for (let k = 0; k < n; k++) {
      physicsTick(typeof auto === 'function' ? auto(car, simTime) : auto ? autopilot(car, track) : input.poll(DT));
      if (probe && k % Math.round(probe / DT) === 0) log.push({ t: +simTime.toFixed(2), s: Math.round(car.proj.s), kmh: Math.round(car.speedF * 3.6), g: car.gear, lat: +car.proj.lat.toFixed(1), y: +car.pos.y.toFixed(3), up: +car.up.y.toFixed(3) });
    }
    autoOn = wasAuto;
    return log;
  };

  window.__game = { brakeMarkers, simulate, autopilot, input, track, get car() { return car; }, timing, world, wallCount, get simTime() { return simTime; }, setAutopilot: (v: boolean) => (autoOn = v), setSetting };

  const frame = (now: number) => {
    requestAnimationFrame(frame);
    let fdt = Math.min((now - last) / 1000, 0.1); last = now;

    // discrete actions (ignored while the menu is open; it handles its own keys)
    if (menu.isOpen) input.pressed.clear();
    if (input.takePressed('KeyP') || input.takePressed('Escape')) menu.open();
    if (input.takePressed('KeyC')) cycleSetting('camera');
    if (input.takePressed('KeyG')) {
      cycleSetting('gearbox');
      showMsg(`${car.manual ? 'Manual' : 'Automatic'} gears<small>${car.manual ? 'E / Q (or RB / LB) to shift' : 'Shifts for you'}</small>`, 1.8);
    }
    if (input.takePressed('KeyE')) car.pendingShift = Math.min(car.pendingShift + 1, 2);
    if (input.takePressed('KeyQ')) car.pendingShift = Math.max(car.pendingShift - 1, -2);
    if (car.shiftDenied) { car.shiftDenied = false; showMsg('Downshift blocked<small>Engine would over-rev</small>', 1); }
    if (input.takePressed('KeyT')) { cycleSetting('tc'); showMsg(`Traction control ${car.tc ? 'ON' : 'OFF'}`, 1.2); }
    if (input.takePressed('KeyM')) { cycleSetting('sound'); showMsg(audio.muted ? 'Sound off' : 'Sound on', 1); }
    if (input.takePressed('KeyV')) {
      cycleSetting('steering');
      showMsg(input.mouse.enabled ? 'Mouse steering<small>Cursor left/right of centre steers · left click throttle · right click brake · scroll to shift</small>' : 'Keyboard steering', 2.2);
    }
    if (input.takePressed('KeyH')) hud.help.classList.toggle('hidden');
    if (input.takePressed('KeyR')) resetToTrack();
    if (input.takePressed('Enter')) restart();
    input.pressed.clear();
    input.mouse.active = started && !paused && !menu.isOpen && !autoOn;

    if (started && !paused) {
      acc += fdt;
      let steps = 0;
      while (acc >= DT && steps < MAX_STEPS_PER_FRAME) {
        physicsTick(autoOn ? autopilot(car, track) : input.poll(DT));
        acc -= DT; steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) acc = 0;
    }
    const alpha = clamp(acc / DT, 0, 1);
    car.render(alpha, paused ? 0 : fdt);
    dust.update(paused ? 0 : fdt, car, camera, renderer);
    updateCamera(fdt);
    audio.update(car);

    // timing events -> HUD
    for (const ev of timing.events.splice(0)) {
      if (ev.type === 'invalid') showMsg(`<span style="color:var(--red)">${ev.reason}</span><small>Lap time deleted</small>`, 2);
      if (ev.type === 'lap') {
        const l = ev.lap;
        const d = ev.deltaToBest != null ? ` <span style="color:${ev.deltaToBest <= 0 ? 'var(--green)' : 'var(--red)'}">${fmtDelta(ev.deltaToBest)}</span>` : '';
        showMsg(l.valid ? `${l.pb ? '<span style="color:var(--purple)">PERSONAL BEST</span><br>' : ''}${fmtTime(l.time)}${l.pb ? '' : d}` : `<span style="color:var(--muted);text-decoration:line-through">${fmtTime(l.time)}</span><small>Invalid lap · ${l.reason}</small>`, 4);
        renderLapList();
      }
    }

    // HUD
    if (!$('hud').hidden) {
      const lapStart = timing.lapStart, lapRunning = lapStart != null;
      hud.lap.textContent = lapRunning ? fmtTime(simTime + alpha * DT - lapStart) : '-:--.---';
      hud.lap.classList.toggle('invalid', lapRunning && !timing.valid);
      hud.state.textContent = !lapRunning ? 'OUT LAP' : timing.valid ? `LAP ${timing.laps.length + 1}` : `LAP ${timing.laps.length + 1} · INVALID (${timing.invalidReason})`;
      const dl = timing.valid ? timing.liveDelta(simTime, car.proj.s) : null;
      hud.delta.textContent = dl != null ? fmtDelta(dl) : '';
      hud.delta.className = 'num ' + (dl == null ? '' : dl <= 0 ? 'ahead' : 'behind');
      for (let k = 0; k < 3; k++) {
        const t = timing.cur[k];
        let txt, cls;
        if (lapRunning && t != null) { txt = fmtSec(t); cls = timing.sectorClass(k, t); }
        else if (lapRunning && timing.next === (k + 1) % 3) { txt = fmtSec(simTime - timing.sectorStart); cls = 'live'; }
        else if (!lapRunning && timing.lastLap) { txt = fmtSec(timing.lastLap.sectors[k]); cls = timing.lastLap.classes[k]; }
        else { txt = '—'; cls = ''; }
        hud.sec[k].className = 'sec ' + cls;
        hud.sec[k].lastChild!.textContent = txt;
      }
      hud.last.textContent = timing.lastLap ? fmtTime(timing.lastLap.time) + (timing.lastLap.valid ? '' : ' ✕') : '—';
      hud.best.textContent = fmtTime(timing.store.bestLap);
      const [b0, b1, b2] = timing.store.bestSectors;
      hud.opt.textContent = b0 != null && b1 != null && b2 != null ? fmtTime(b0 + b1 + b2) : '—';
      hud.speed.textContent = String(Math.round(Math.abs(car.speedF) * 3.6));
      hud.gear.textContent = car.gear === 0 ? 'R' : !car.manual && Math.abs(car.speedF) < 0.5 && car.throttle < 0.05 ? 'N' : String(car.gear);
      updateDash();
      const surfName = SURF[Math.max(...car.wheels.map((w) => w.surf))].name;
      hud.flags.textContent = `${car.manual ? 'MANUAL' : 'AUTO'} · TC ${car.tc ? 'ON' : 'OFF'}${autoOn ? ' · AUTOPILOT' : ''}${paused ? ' · PAUSED' : ''}${surfName !== 'asphalt' ? ' · ' + surfName.toUpperCase() : ''}`;
      if (msgTimer > 0 && (msgTimer -= fdt) <= 0) hud.msg.classList.remove('show');
      if (input.mouse.enabled) $('mouseSteerKnob').style.left = (50 - input.mouse.steer * 50) + '%';
      if (helpTimer > 0 && (helpTimer -= fdt) <= 0) hud.help.classList.add('hidden');

      // minimap
      mctx.clearRect(0, 0, mm.width, mm.height);
      mctx.drawImage(mmBase, 0, 0);
      const hx = car.fwd.x, hz = car.fwd.z, px = mmX(car.pos.x), py = mmY(car.pos.z);
      mctx.beginPath(); mctx.moveTo(px + hx * 14, py + hz * 14); mctx.lineTo(px - hz * 8 - hx * 8, py + hx * 8 - hz * 8); mctx.lineTo(px + hz * 8 - hx * 8, py - hx * 8 - hz * 8); mctx.closePath();
      mctx.fillStyle = '#ff6a13'; mctx.strokeStyle = '#111'; mctx.lineWidth = 3; mctx.stroke(); mctx.fill();
    }

    renderer.render(scene, camera);
  };
  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error(err);
  const ls = document.getElementById('loadState');
  if (!ls) return;
  ls.className = 'err';
  ls.textContent = 'Failed to start: ' + (err instanceof Error ? err.message : String(err)) + ' (needs WebGL)';
});
