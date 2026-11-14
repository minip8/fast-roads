import trackCsv from '../tracks/melbourne.csv?raw';
import RAPIER from '@dimforge/rapier3d-compat';
import { EngineAudio } from './audio';
import { autopilot } from './autopilot';
import { CameraRig } from './camera';
import { Car, type DriveInput } from './car';
import { CARS } from './cars';
import { DT, MAX_STEPS_PER_FRAME } from './config';
import { $ } from './dom';
import { Dust } from './dust';
import { Hud } from './hud';
import { Input, MOUSE_DEADZONE, MOUSE_RANGE } from './input';
import { Menu } from './menu';
import { loadSettings, nextOption, saveSettings, SETTING_KEYS, type SettingKey, type Settings } from './settings';
import { needsReset, stepPhysics } from './sim';
import { buildStage } from './stage';
import { StartupError } from './startup';
import { Timing } from './timing';
import { buildTrack, buildTrackColliders, parseCSV } from './track';
import { clamp } from './util';

// ============================================================================
// Main: wires the modules together and runs the game loop. Started by boot.ts.
// ============================================================================
// Test hook (see CLAUDE.md); set in main().
declare global { interface Window { __game?: unknown } }

export async function main() {
  const params = new URLSearchParams(location.search);
  await RAPIER.init().catch((err: unknown) => { throw new StartupError('physics', 'Rapier failed to initialise', { cause: err }); });
  $('loadState').textContent = 'Building circuit…';
  await new Promise((r) => setTimeout(r, 0));   // let the loading text paint

  const track = buildTrack(parseCSV(trackCsv));
  const stage = buildStage($<HTMLCanvasElement>('view'), track);
  const { renderer, scene, camera } = stage;

  // Physics
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  const wallCount = buildTrackColliders(track, world);
  let car = new Car(world, track, scene, CARS.f1);   // replaced when the Car setting changes; read it at call time
  const spawnS = track.L - 160;
  car.placeAt(spawnS, 0);
  const timing = new Timing(track, car.spec.storeKey);
  const input = new Input();
  const audio = new EngineAudio();
  const dust = new Dust(scene);
  const hud = new Hud(track, stage.bounds, timing);
  const cam = new CameraRig(stage);

  // Game state
  // The autopilot is a development/testing tool: only ?autopilot in the URL (or the __game test hook) turns it on.
  let started = params.has('autopilot'), paused = false, autoOn = params.has('autopilot');
  let autoStuck = 0, simTime = 0, acc = 0, last = performance.now();

  const restart = () => { car.placeAt(spawnS, 0); timing.reset(); cam.reset(); hud.showMsg('Session restarted<small>Cross the line to start a lap</small>'); };
  const resetToTrack = () => {
    car.placeAt(car.proj.s, 0);
    timing.invalidate('RESET');
    cam.reset();
  };

  // ---------------- Settings ----------------
  const settings = loadSettings();
  // What changing each setting does.
  const applySetting: { [K in SettingKey]: (v: Settings[K]) => void } = {
    car: (id) => {
      if (car.spec.id === id) return;
      car.destroy();
      car = new Car(world, track, scene, CARS[id]);
      car.manual = settings.gearbox === 'manual'; car.tc = settings.tc === 'on';
      car.placeAt(spawnS, 0);
      timing.useStore(car.spec.storeKey); timing.reset(); hud.clearLaps();
      cam.reset(); acc = 0;
      if (id === 'drift') hud.showMsg(`${car.spec.name}<small>Loose rear: brake while turning to kick it out · TC off (T) for big slides</small>`, 3);
    },
    gearbox: (v) => { car.manual = v === 'manual'; },
    steering: (v) => { input.setMouse(v === 'mouse'); $('mouseSteer').hidden = v !== 'mouse'; },
    mouseSens: (v) => { input.mouse.range = MOUSE_RANGE[v]; },
    mouseDeadzone: (v) => { input.mouse.deadzone = MOUSE_DEADZONE[v]; },
    camera: (v) => { cam.mode = v; },
    tc: (v) => { car.tc = v === 'on'; },
    sound: (v) => { audio.setMuted(v === 'off'); },
  };
  const setSetting = <K extends SettingKey>(key: K, value: Settings[K]) => {
    settings[key] = value;
    saveSettings(settings);
    applySetting[key](value);
    menu.refresh();
  };
  const cycleSetting = (key: SettingKey, dir = 1) => setSetting(key, nextOption(key, settings[key], dir));

  // ---------------- Menu ----------------
  const menu = new Menu({
    settings, setSetting, cycleSetting, restart,
    started: () => started,
    bestLap: () => timing.store.bestLap,
    resetBestTimes: () => {
      try { localStorage.removeItem(timing.storeKey); } catch { /* storage unavailable */ }
      timing.useStore(timing.storeKey);
      hud.clearLaps();
    },
    onOpen: () => { paused = true; },
    onClose: () => {
      started = true; paused = false; hud.hidden = false; audio.start();
      input.pressed.clear();                       // the key that closed the menu shouldn't also act in-game
      input.mouse.lmb = input.mouse.rmb = false;   // the click that closed the menu isn't throttle
    },
  });

  for (const k of SETTING_KEYS) setSetting(k, settings[k]);   // apply saved choices
  if (started) { menu.isOpen = false; $('overlay').classList.add('hidden'); hud.hidden = false; }   // ?autopilot skips the menu
  else menu.show();

  // ---------------- Simulation ----------------
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

  window.__game = { brakeMarkers: stage.brakeMarkers, simulate, autopilot, input, track, get car() { return car; }, timing, world, wallCount, get simTime() { return simTime; }, setAutopilot: (v: boolean) => (autoOn = v), setSetting };

  // In-game hotkeys (ignored while the menu is open; it handles its own keys).
  const handleHotkeys = () => {
    if (menu.isOpen) input.pressed.clear();
    if (input.takePressed('KeyP') || input.takePressed('Escape')) menu.open();
    if (input.takePressed('KeyC')) cycleSetting('camera');
    if (input.takePressed('KeyG')) {
      cycleSetting('gearbox');
      hud.showMsg(`${car.manual ? 'Manual' : 'Automatic'} gears<small>${car.manual ? 'E / Q (or RB / LB) to shift' : 'Shifts for you'}</small>`, 1.8);
    }
    if (input.takePressed('KeyE')) car.pendingShift = Math.min(car.pendingShift + 1, 2);
    if (input.takePressed('KeyQ')) car.pendingShift = Math.max(car.pendingShift - 1, -2);
    if (car.shiftDenied) { car.shiftDenied = false; hud.showMsg('Downshift blocked<small>Engine would over-rev</small>', 1); }
    if (input.takePressed('KeyT')) { cycleSetting('tc'); hud.showMsg(`Traction control ${car.tc ? 'ON' : 'OFF'}`, 1.2); }
    if (input.takePressed('KeyM')) { cycleSetting('sound'); hud.showMsg(audio.muted ? 'Sound off' : 'Sound on', 1); }
    if (input.takePressed('KeyV')) {
      cycleSetting('steering');
      hud.showMsg(input.mouse.enabled ? 'Mouse steering<small>Cursor left/right of centre steers · left click throttle · right click brake · scroll to shift</small>' : 'Keyboard steering', 2.2);
    }
    if (input.takePressed('KeyH')) hud.toggleHelp();
    if (input.takePressed('KeyR')) resetToTrack();
    if (input.takePressed('Enter')) restart();
    input.pressed.clear();
  };

  const frame = (now: number) => {
    requestAnimationFrame(frame);
    const fdt = Math.min((now - last) / 1000, 0.1); last = now;

    handleHotkeys();
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
    cam.update(fdt, car);
    audio.update(car, fdt, started && !paused);

    hud.handleEvents(timing);
    hud.update({ car, timing, simTime, alpha, dt: fdt, autoOn, paused, mouseSteer: input.mouse.enabled ? input.mouse.steer : null });

    renderer.render(scene, camera);
  };
  requestAnimationFrame(frame);
}
