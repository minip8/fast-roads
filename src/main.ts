import trackCsv from '../tracks/melbourne.csv?raw';
import RAPIER from '@dimforge/rapier3d-compat';
import { EngineAudio } from './audio';
import { autopilot } from './autopilot';
import { CameraRig } from './camera';
import type { Car, DriveInput } from './car';
import { CARS } from './cars';
import { DT, MAX_STEPS_PER_FRAME } from './config';
import { $ } from './dom';
import { Dust } from './dust';
import { Hud } from './hud';
import { Input, MOUSE_DEADZONE, MOUSE_RANGE } from './input';
import { Menu } from './menu';
import { loadSettings, nextOption, saveSettings, SETTING_KEYS, type SettingKey, type Settings } from './settings';
import { Session } from './sim';
import { buildStage } from './stage';
import { StartupError } from './startup';
import type { Timing } from './timing';
import { buildTrack, parseCSV, type Track } from './track';
import { clamp } from './util';

// ============================================================================
// Main: wires the modules together and runs the game loop. Started by boot.ts.
// ============================================================================
// Test hook (see CLAUDE.md), set in main(): drive the game from the console or a headless browser.
type Driver = boolean | ((car: Car, simTime: number) => DriveInput);   // true = autopilot, false = live input
export interface ProbeSample { t: number; s: number; kmh: number; g: number; lat: number; y: number; up: number }
export interface GameHook {
  simulate(seconds: number, driver?: Driver, probeSecs?: number | null): ProbeSample[];
  setAutopilot(on: boolean): void;
  setSetting<K extends SettingKey>(key: K, value: Settings[K]): void;
  readonly car: Car;                 // a getter: switching car replaces the object
  readonly simTime: number;
  readonly session: Session; readonly timing: Timing; readonly track: Track; readonly input: Input;
  readonly autopilot: typeof autopilot;
  readonly brakeMarkers: ReturnType<typeof buildStage>['brakeMarkers'];
}
declare global { interface Window { __game?: GameHook } }

export async function main() {
  const params = new URLSearchParams(location.search);
  await RAPIER.init().catch((err: unknown) => { throw new StartupError('physics', 'Rapier failed to initialise', { cause: err }); });
  $('loadState').textContent = 'Building circuit…';
  await new Promise((r) => setTimeout(r, 0));   // let the loading text paint

  const track = buildTrack(parseCSV(trackCsv));
  const stage = buildStage($<HTMLCanvasElement>('view'), track);
  const { renderer, scene, camera } = stage;

  // Physics. session.car is replaced when the Car setting changes: read it at call time.
  const session = new Session(track, scene, CARS.f1), { timing } = session;
  const input = new Input();
  const audio = new EngineAudio();
  const dust = new Dust(scene);
  const hud = new Hud(track, stage.bounds, timing);
  const cam = new CameraRig(stage);

  // Game state
  // The autopilot is a development/testing tool: only ?autopilot in the URL (or the __game test hook) turns it on.
  let started = params.has('autopilot'), paused = false, autoOn = params.has('autopilot');
  let acc = 0, last = performance.now();
  session.onReset = () => cam.reset();

  const restart = () => { session.restart(); hud.showMsg('Session restarted<small>Cross the line to start a lap</small>'); };

  // ---------------- Settings ----------------
  const settings = loadSettings();
  // What changing each setting does.
  const applySetting: { [K in SettingKey]: (v: Settings[K]) => void } = {
    car: (id) => {
      if (session.car.spec.id === id) return;
      session.setCar(CARS[id]);
      applySetting.gearbox(settings.gearbox); applySetting.tc(settings.tc);
      hud.clearLaps(); acc = 0;
      if (id === 'drift') hud.showMsg(`${CARS[id].name}<small>Loose rear: brake while turning to kick it out · TC off (T) for big slides</small>`, 3);
    },
    gearbox: (v) => { session.car.manual = v === 'manual'; },
    steering: (v) => { input.setMouse(v === 'mouse'); $('mouseSteer').hidden = v !== 'mouse'; },
    mouseSens: (v) => { input.mouse.range = MOUSE_RANGE[v]; },
    mouseDeadzone: (v) => { input.mouse.deadzone = MOUSE_DEADZONE[v]; },
    camera: (v) => { cam.mode = v; },
    tc: (v) => { session.car.tc = v === 'on'; },
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

  // ---------------- Test hook ----------------
  // Run the simulation headless (no rendering), e.g. __game.simulate(90, true)
  const simulate = (seconds: number, driver: Driver = true, probe: number | null = null) => {
    const n = Math.round(seconds / DT), log: ProbeSample[] = [];
    for (let k = 0; k < n; k++) {
      const c = session.car;
      session.tick(typeof driver === 'function' ? driver(c, session.simTime) : driver ? autopilot(c, track) : input.poll(DT), driver === true);
      if (probe && k % Math.round(probe / DT) === 0) {
        log.push({ t: +session.simTime.toFixed(2), s: Math.round(c.proj.s), kmh: Math.round(c.speedF * 3.6), g: c.gear, lat: +c.proj.lat.toFixed(1), y: +c.pos.y.toFixed(3), up: +c.up.y.toFixed(3) });
      }
    }
    return log;
  };
  window.__game = {
    simulate, setSetting, setAutopilot: (on) => { autoOn = on; },
    get car() { return session.car; }, get simTime() { return session.simTime; },
    session, timing, track, input, autopilot, brakeMarkers: stage.brakeMarkers,
  };

  // In-game hotkeys (ignored while the menu is open; it handles its own keys).
  const handleHotkeys = () => {
    const car = session.car;
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
    if (input.takePressed('KeyR')) session.resetToTrack();
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
        session.tick(autoOn ? autopilot(session.car, track) : input.poll(DT), autoOn);
        acc -= DT; steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) acc = 0;
    }
    const alpha = clamp(acc / DT, 0, 1), car = session.car;
    car.render(alpha, paused ? 0 : fdt);
    dust.update(paused ? 0 : fdt, car, camera, renderer);
    cam.update(fdt, car);
    audio.update(car, fdt, started && !paused);

    hud.handleEvents(timing);
    hud.update({ car, timing, simTime: session.simTime, alpha, dt: fdt, autoOn, paused, mouseSteer: input.mouse.enabled ? input.mouse.steer : null });

    renderer.render(scene, camera);
  };
  requestAnimationFrame(frame);
}
