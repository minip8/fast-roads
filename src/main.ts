import RAPIER from '@dimforge/rapier3d-compat';
import { EngineAudio } from './audio';
import { autopilot } from './autopilot';
import { CameraRig } from './camera';
import { CARS, type CarId } from './cars';
import { CockpitDisplay } from './cockpitDisplay';
import { DT, MAX_STEPS_PER_FRAME } from './config';
import { $ } from './dom';
import { Dust } from './dust';
import { GhostCar } from './ghostCar';
import { Hud } from './hud';
import { Input, MOUSE_DEADZONE, MOUSE_RANGE, PAD_DEADZONE } from './input';
import { bindKey, copyBindings, DEFAULT_BINDINGS, keyLabel, keysFor, loadBindings, MENU_KEY, saveBindings, type Action } from './keys';
import { Menu } from './menu';
import { RearMirror } from './mirror';
import { DEFAULT_SETTINGS, loadSettings, nextOption, saveSettings, SETTING_KEYS, type SettingKey, type Settings } from './settings';
import { Session } from './sim';
import { buildStage } from './stage';
import { StartupError } from './startup';
import { clearStore, loadStore, type Timing } from './timing';
import { buildTrack, parseCSV, type Track } from './track';
import { loadTrackCsv, TRACKS, type TrackId } from './tracks';
import { clamp } from './util';
import type { DriveInput, Vehicle } from './vehicle';

// ============================================================================
// Main: wires the modules together and runs the game loop. Started by boot.ts.
// ============================================================================
// Test hook (see CLAUDE.md), set in main(): drive the game from the console or a headless browser.
type Driver = boolean | ((car: Vehicle, simTime: number) => DriveInput);   // true = autopilot, false = live input
export interface ProbeSample { t: number; s: number; kmh: number; g: number; lat: number; y: number; up: number }
export interface GameHook {
  simulate(seconds: number, driver?: Driver, probeSecs?: number | null): ProbeSample[];
  setAutopilot(on: boolean): void;
  setSetting<K extends SettingKey>(key: K, value: Settings[K]): void;
  readonly car: Vehicle;             // a getter: switching car replaces the object
  readonly simTime: number;
  readonly session: Session; readonly timing: Timing; readonly track: Track; readonly input: Input;
  readonly autopilot: typeof autopilot;
  readonly brakeMarkers: ReturnType<typeof buildStage>['brakeMarkers'];
  readonly stage: ReturnType<typeof buildStage>;   // renderer, scene, camera (screenshots, renderer.info)
  readonly mirror: RearMirror;                      // the rear-view mirror (its pass's draw calls: mirror.stats)
}
declare global { interface Window { __game?: GameHook } }

export async function main() {
  const params = new URLSearchParams(location.search);
  await RAPIER.init().catch((err: unknown) => { throw new StartupError('physics', 'Rapier failed to initialise', { cause: err }); });
  // The circuit is chosen before anything is built; changing it reloads the page (see applySetting.track).
  const settings = loadSettings();
  const def = TRACKS[settings.track];
  $('loadState').textContent = `Building ${def.name}…`;
  $('trkName').textContent = `${def.name} · ${def.place}`;
  $('menuSub').textContent = `Time trial · ${def.name}, ${def.place}`;
  await new Promise((r) => setTimeout(r, 0));   // let the loading text paint

  const csv = await loadTrackCsv(def.id).catch((err: unknown) => { throw new StartupError('download', `${def.name} failed to load`, { cause: err }); });
  const track = buildTrack(parseCSV(csv), { street: def.street });
  const stage = buildStage($<HTMLCanvasElement>('view'), track, def);
  const { renderer, scene, camera } = stage;

  // Physics. session.car is replaced when the Car setting changes: read it at call time.
  const session = new Session(track, scene, CARS[settings.car], def), { timing } = session;
  const input = new Input();
  let bindings = loadBindings();
  input.bindings = bindings;
  const audio = new EngineAudio();
  const dust = new Dust(scene);
  const hud = new Hud(track, stage.bounds, timing);
  const cam = new CameraRig(stage);
  const cockpitDisplay = new CockpitDisplay();
  const ghost = new GhostCar(scene);
  const mirror = new RearMirror($('mirror'));
  hud.setKeys(bindings);

  // Game state
  // The autopilot is a development/testing tool: only ?autopilot in the URL (or the __game test hook) turns it on.
  let started = params.has('autopilot'), paused = false, autoOn = params.has('autopilot');
  let acc = 0, last = performance.now();
  session.onReset = () => cam.reset();

  const restart = () => { session.restart(); hud.showMsg('Flying lap<small>Starts at the line</small>', 1.5); };

  // ---------------- Settings ----------------
  // What changing each setting does.
  const applySetting: { [K in SettingKey]: (v: Settings[K]) => void } = {
    // Track, walls, scenery, timing and minimap are all built once at startup, so another circuit means starting
    // again: setSetting has already saved the choice, and the reload picks it up.
    track: (id) => { if (id !== def.id) location.reload(); },
    car: (id) => {
      if (session.car.spec.id === id) return;
      session.setCar(CARS[id]);
      applySetting.gearbox(settings.gearbox); applySetting.tc(settings.tc); applySetting.assist(settings.assist);
      hud.clearLaps(); acc = 0;
      const { name, hint } = CARS[id];
      if (hint) hud.showMsg(`${name}<small>${hint}</small>`, 3);
    },
    gearbox: (v) => { session.car.manual = v === 'manual'; },
    tc: (v) => { session.car.tc = v === 'on'; },
    assist: (v) => { session.car.assist = v === 'on'; },
    ghost: (v) => { ghost.enabled = v === 'on'; },
    steering: (v) => { input.setMouse(v === 'mouse'); applySetting.mouseBar(settings.mouseBar); },
    mouseSens: (v) => { input.mouse.range = MOUSE_RANGE[v]; },
    mouseDeadzone: (v) => { input.mouse.deadzone = MOUSE_DEADZONE[v]; },
    padDeadzone: (v) => { input.padDeadzone = PAD_DEADZONE[v]; },
    camera: (v) => { cam.mode = v; },
    fov: (v) => { cam.fovOffset = v; },
    speedFov: (v) => { cam.speedFov = v === 'on'; },
    shake: (v) => { cam.shake = v === 'on'; },
    hands: (v) => { cam.hands = v === 'on'; },
    units: (v) => { hud.setUnits(v); cockpitDisplay.unit = v; },
    timingPanel: (v) => hud.setTimingPanel(v),
    delta: (v) => hud.setDelta(v === 'on'),
    minimap: (v) => hud.setMinimap(v),
    tyres: (v) => hud.setTyres(v === 'on'),
    mirror: (v) => { mirror.mode = v; },
    mouseBar: (v) => { $('mouseSteer').hidden = settings.steering !== 'mouse' || v === 'off'; },
    help: (v) => hud.setHelpMode(v),
    fps: (v) => hud.setFps(v === 'on'),
    hudScale: (v) => hud.setScale(v),
    hudOpacity: (v) => hud.setOpacity(v),
    resolution: (v) => stage.setResolution(v / 100),
    shadows: (v) => stage.setShadows(v),
    brightness: (v) => stage.setBrightness(v / 100),
    sound: (v) => { audio.setMuted(v === 'off'); },
    volume: (v) => audio.setVolume(v / 100),
  };
  const setSetting = <K extends SettingKey>(key: K, value: Settings[K]) => {
    settings[key] = value;
    saveSettings(settings);
    applySetting[key](value);
    menu.refresh();
  };
  const cycleSetting = (key: SettingKey, dir = 1) => setSetting(key, nextOption(key, settings[key], dir));
  const setBindings = (b: typeof bindings) => {
    bindings = b; input.bindings = b; saveBindings(b); hud.setKeys(b);
  };
  const keyText = (a: Action) => keysFor(bindings, a).map(keyLabel).join(' / ') || 'unbound';

  // Best laps for the menu's cards: the live store for this car here, saved ones (read once per menu opening) elsewhere.
  const bestCache = new Map<string, number | null>();
  const bestLap = (trackId: TrackId, carId: CarId) => {
    if (trackId === def.id && carId === session.car.spec.id) return timing.store.bestLap;
    const key = TRACKS[trackId].storeKey + CARS[carId].storeKey;
    if (!bestCache.has(key)) bestCache.set(key, loadStore(key).bestLap);
    return bestCache.get(key)!;
  };

  // ---------------- Menu ----------------
  const menu = new Menu({
    settings, setSetting, cycleSetting, restart, bestLap,
    loadedTrack: def.id,
    started: () => started,
    resetSettings: () => {
      for (const k of SETTING_KEYS) if (k !== 'car' && k !== 'track' && settings[k] !== DEFAULT_SETTINGS[k]) setSetting(k, DEFAULT_SETTINGS[k]);
    },
    bindings: () => bindings,
    rebind: (action, slot, code) => { setBindings(bindKey(bindings, action, slot, code)); menu.rebuild(); },
    resetBindings: () => { setBindings(copyBindings(DEFAULT_BINDINGS)); menu.rebuild(); },
    resetBestTimes: () => {
      clearStore(timing.storeKey);
      timing.useStore(timing.storeKey);
      hud.clearLaps();
    },
    onOpen: () => { paused = true; bestCache.clear(); },
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
    session, timing, track, input, autopilot, brakeMarkers: stage.brakeMarkers, stage, mirror,
  };

  // In-game hotkeys (ignored while the menu is open; it handles its own keys).
  const handleHotkeys = () => {
    const car = session.car;
    if (menu.isOpen) input.pressed.clear();
    if (input.takeAction('menu') || input.takePressed(MENU_KEY)) menu.open();
    if (input.takeAction('camera')) cycleSetting('camera');
    if (input.takeAction('gearbox')) {
      cycleSetting('gearbox');
      hud.showMsg(`${car.manual ? 'Manual' : 'Automatic'} gears<small>${car.manual ? `${keyText('shiftUp')} up, ${keyText('shiftDown')} down (or RB / LB)` : 'Shifts for you'}</small>`, 1.8);
    }
    if (input.takeAction('shiftUp')) car.pendingShift = Math.min(car.pendingShift + 1, 2);
    if (input.takeAction('shiftDown')) car.pendingShift = Math.max(car.pendingShift - 1, -2);
    if (car.shiftDenied) { car.shiftDenied = false; hud.showMsg('Downshift blocked<small>Engine would over-rev</small>', 1); }
    if (input.takeAction('tc')) { cycleSetting('tc'); hud.showMsg(`Traction control ${car.tc ? 'ON' : 'OFF'}`, 1.2); }
    if (input.takeAction('mute')) { cycleSetting('sound'); hud.showMsg(audio.muted ? 'Sound off' : 'Sound on', 1); }
    if (input.takeAction('steering')) {
      cycleSetting('steering');
      hud.showMsg(input.mouse.enabled ? 'Mouse steering<small>Cursor left/right of centre steers · left click throttle · right click brake · scroll to shift</small>' : 'Keyboard steering', 2.2);
    }
    if (input.takeAction('help')) hud.toggleHelp();
    if (input.takeAction('restart')) restart();   // back to the start of the lap
    input.pressed.clear();
  };

  const frame = (now: number) => {
    requestAnimationFrame(frame);
    const fdt = Math.min((now - last) / 1000, 0.1); last = now;

    const padMenu = input.pollMenuPad();   // every frame, so a button held when the menu opens doesn't count
    if (menu.isOpen) for (const code of padMenu) menu.press(code);
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
    cam.lookBack = !menu.isOpen && input.lookingBack();
    cam.update(fdt, car);
    ghost.update(car, timing, session.simTime, alpha, camera);
    cockpitDisplay.update(car, timing, session.simTime, alpha, cam.mode === 'driver' && !cam.lookBack);
    audio.update(car, fdt, started && !paused);

    hud.handleEvents(timing);
    hud.update({ car, timing, simTime: session.simTime, alpha, dt: fdt, autoOn, paused, mouseSteer: input.mouse.enabled ? input.mouse.steer : null, ghost: ghost.shown ? ghost.mapPos : null });

    renderer.render(scene, camera);
    const cockpitView = cam.mode === 'onboard' || cam.mode === 'driver';
    mirror.render(renderer, scene, stage.sun, car, mirror.wanted(cockpitView) && !hud.hidden && !menu.isOpen && !cam.lookBack, ghost, camera);
  };
  requestAnimationFrame(frame);
}
