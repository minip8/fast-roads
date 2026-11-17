import RAPIER from '@dimforge/rapier3d-compat';
import { EngineAudio } from './audio';
import { autopilot } from './autopilot';
import { CameraRig } from './camera';
import { CARS, type CarId } from './cars';
import { CockpitDisplay } from './cockpitDisplay';
import { conditionsFromUrl } from './conditions';
import { DT, MAX_STEPS_PER_FRAME } from './config';
import { $ } from './dom';
import { Dust } from './dust';
import { GhostCar } from './ghostCar';
import { Hud } from './hud';
import { Input, MOUSE_DEADZONE, MOUSE_RANGE, PAD_DEADZONE } from './input';
import { bindKey, copyBindings, DEFAULT_BINDINGS, keyLabel, keysFor, loadBindings, MENU_KEY, saveBindings, type Action } from './keys';
import { Menu, type MenuHost, type NetStatus } from './menu';
import { RearMirror } from './mirror';
import type { Multiplayer } from './multiplayer';
import type { NetClient, NetEvent } from './net';
import type { Joined } from './netGame';
import { clearSeat, defaultServer, inviteUrl, loadNetPrefs, loadSeat, parseInvite, randomName, roomFromUrl, roomUrl, saveNetPrefs, saveSeat } from './netPrefs';
import { DEFAULT_SETTINGS, loadSettings, nextOption, saveSettings, SETTING_KEYS, type SettingKey, type Settings } from './settings';
import { Session } from './sim';
import { buildStage } from './stage';
import { StartupError } from './startup';
import { clearStore, loadStore, type Timing } from './timing';
import { buildTrack, parseCSV, type Track } from './track';
import { loadTrackCsv, TRACKS, type TrackId } from './tracks';
import { clamp } from './util';
import type { DriveInput, Vehicle } from './vehicle';
import { Weather, weatherFromUrl } from './weather';

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
  readonly multiplayer: Multiplayer | null;         // the room joined (null: single-player)
  readonly weather: Weather;                        // rain and wet track, as drawn and heard (weather.set)
}
type NetModule = typeof import('./netGame');
// Multiplayer while in a room (netGame.ts, loaded only then): the glue, the other cars drawn, the board.
interface NetRuntime {
  mp: Multiplayer; view: InstanceType<NetModule['RemoteCars']>; board: InstanceType<NetModule['NetHud']>;
  mod: NetModule; server: string; log: InstanceType<NetModule['lobby']['RoomLog']>;   // (for the menu's room tab)
}
declare global { interface Window { __game?: GameHook } }

export async function main() {
  const params = new URLSearchParams(location.search);
  await RAPIER.init().catch((err: unknown) => { throw new StartupError('physics', 'Rapier failed to initialise', { cause: err }); });
  // The circuit is chosen before anything is built; changing it reloads the page (see applySetting.track).
  const settings = loadSettings();
  // A room in the link (?room=CODE): joined before the circuit is built, since the room's circuit is the one to build.
  // It only joins (never creates it: a room that has closed offers to open it again); this tab's seat
  // (rejoin token, sessionStorage) comes back as the same player after a reload or a circuit change.
  const link = roomFromUrl(params);
  let booted: { mod: NetModule; net: NetClient; server: string } | null = null, bootError: NetStatus | null = null, bootKeep = 0;
  if (link) {
    const prefs = loadNetPrefs(), server = link.server || prefs.server || defaultServer(), name = netName();
    $('loadState').textContent = `Joining room ${link.room}…`;
    const mod = await import('./netGame').catch(() => null);
    const r: Joined = mod ? await mod.connect({ server, room: link.room, name, car: settings.car, circuit: settings.track, mode: 'join', token: loadSeat(link.room, server) ?? undefined })
      : { ok: false, code: -1, text: 'Multiplayer failed to load.', offer: 'reload' };
    if (r.ok && mod) {
      if (r.net.circuit !== settings.track && r.net.circuit in TRACKS) { settings.track = r.net.circuit as TrackId; saveSettings(settings); }
      booted = { mod, net: r.net, server };
      // keep the link alive while the circuit is built (the relay drops a client it has not heard from in 10 s); the
      // events wait in the client for Multiplayer
      const net = r.net;
      bootKeep = window.setInterval(() => net.update(performance.now() / 1000), 250);   // (cleared by startNet)
    } else if (!r.ok) bootError = { state: 'error', text: r.text, offer: r.offer, room: link.room };
  }
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
  // ?wear=3&wet=0.6&rain=0.5&compound=medium&airc=18&trackc=24: race conditions single-player, until race sessions
  // exist (a development tool, no menu). Laps in them keep best times of their own (the '.dev' store tag).
  const devRace = conditionsFromUrl(params);
  const fitDevCompound = (car: Vehicle) => {
    const c = devRace?.compound;
    if (c && c !== car.compound.id && car.compounds.some((k) => k.id === c)) car.fitTyres(c, 'lap');
  };
  if (devRace) {
    session.setStoreTag('.dev');
    session.setConditions(devRace.conditions);
    fitDevCompound(session.car);
    session.restart();   // at the start speed for this grip
  }
  // ?opponents=N (that many of the player's car) or ?opponents=lcgt3,drift: autopilot cars starting 30 m apart ahead
  // of the player, to see car-to-car contact. A development tool: no menu, HUD or minimap for them.
  for (const [k, id] of opponentCars(params.get('opponents'), settings.car).entries()) {
    fitDevCompound(session.addCar(CARS[id], { s: track.L - def.startBack + 30 * (k + 1) }).car);
  }
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
  const weather = new Weather(stage, audio), devWeather = weatherFromUrl(params);   // ?rain=0.7&wet=0.5 (visuals)
  hud.setKeys(bindings);

  // Game state
  // The autopilot is a development/testing tool: only ?autopilot in the URL (or the __game test hook) turns it on.
  let started = params.has('autopilot'), paused = false, autoOn = params.has('autopilot');
  let acc = 0, last = performance.now(), menuTick = 0;
  session.onReset = () => cam.reset();

  const restart = () => { session.restart(); hud.showMsg('Flying lap<small>Starts at the line</small>', 1.5); };

  // ---------------- Multiplayer ----------------
  // Entering a room (create, join, a link, a retry), leaving it, and what the room's events mean for the page: a
  // circuit change reloads onto it with this tab's seat, a car the room requires is switched to, the race's results
  // open the menu. Everything in the car itself is Multiplayer's (netGame.ts).
  let netRt: NetRuntime | null = null;
  let netStatus: NetStatus = bootError ?? { state: 'off', text: '' };
  // what Try again does: the last attempt (a create stays a create), or rejoining the room last in
  let lastAttempt: (() => void) | null = link ? () => { void enterRoom('join', link.room, serverFor(link.server)); } : null;
  // CONNECT (in-car side): the starting compound the menu's room tab offers. Held here until Multiplayer takes it
  // (e.g. `netRt.mp.startCompound = id`), which fits it when a session puts the car on track.
  let startTyre: string | null = null;
  const labels = document.createElement('div');
  labels.id = 'netLabels';
  $('hud').before(labels);   // under the HUD: a tag passes behind a panel, as the car it names does
  const serverFor = (fromLink = '') => fromLink || loadNetPrefs().server || defaultServer();
  const followRoomCar = (net: NetClient) => {   // a room that allows one car: switch to it
    const only = net.settings.car;
    if (only && only in CARS && only !== settings.car) setSetting('car', only as CarId);
  };
  const startNet = (mod: NetModule, net: NetClient, server: string) => {
    clearInterval(bootKeep);
    netRt = { mp: new mod.Multiplayer(net, session), view: new mod.RemoteCars(scene, labels), board: new mod.NetHud($('leftCol')), mod, server, log: new mod.lobby.RoomLog(net) };
    netStatus = { state: 'joined', text: '' };
    lastAttempt = () => { void enterRoom('join', net.room, server); };
    saveSeat({ room: net.room, server, token: net.token });
    history.replaceState(null, '', roomUrl(net.room, server));
    followRoomCar(net);
    menu.showTab('online');
  };
  const stopNet = (status: NetStatus) => {
    if (!netRt) return;
    netRt.mp.close(); netRt.view.dispose(); netRt.board.dispose(); netRt = null;
    session.proxies.length = 0;
    netStatus = status;
    history.replaceState(null, '', roomUrl(null));
    menu.rebuild();
  };
  // The connection ended. fatal: the relay's last fatal error (code), if it sent one.
  const netClosed = (reason: string, fatal: { code: number; message: string } | null) => {
    if (!netRt) return;
    const room = netRt.mp.net.room;
    stopNet({ state: 'error', text: netRt.mod.lobby.closedText(room, reason, fatal), offer: 'retry', room });
    if (!menu.isOpen) menu.open();
  };
  // Into a room: join it (with this tab's seat, if it has one there), or create one (a made-up code, or `room`).
  const enterRoom = async (mode: 'join' | 'create', room: string | null, server: string) => {
    if (netRt || netStatus.state === 'connecting') return;
    const name = netName();
    lastAttempt = () => { void enterRoom(mode, room, server); };
    netStatus = { state: 'connecting', text: mode === 'create' ? (room ? `Opening room ${room}…` : 'Opening a room…') : `Joining room ${room}…` };
    menu.refresh();
    const mod = await import('./netGame').catch(() => null);
    const o = { server, name, car: session.car.spec.id, circuit: def.id };
    const r: Joined = !mod ? { ok: false, code: -1, text: 'Multiplayer failed to load.', offer: 'reload' }
      : mode === 'create' ? await mod.createRoom(o, room ?? undefined, room ? 1 : 5)
      : await mod.connect({ ...o, room: room!, mode, token: loadSeat(room!, server) ?? undefined });
    if (!r.ok || !mod) { netStatus = { state: 'error', text: r.ok ? '' : r.text, offer: r.ok ? undefined : r.offer, room: room ?? undefined }; menu.refresh(); return; }
    if (r.net.circuit !== def.id && r.net.circuit in TRACKS) {
      // the room is at another circuit, and the circuit is built once: load the page there, back into the room
      netStatus = { state: 'connecting', text: `Room ${r.net.room} is at ${TRACKS[r.net.circuit as TrackId].name}: loading it…` }; menu.refresh();
      saveSeat({ room: r.net.room, server, token: r.net.token });
      r.net.close('reload');
      settings.track = r.net.circuit as TrackId; saveSettings(settings);
      location.href = roomUrl(r.net.room, server);
      return;
    }
    startNet(mod, r.net, server);
  };
  // Every room event, in order (after Multiplayer has handled it).
  const onNetEvent = (e: NetEvent) => {
    if (!netRt) return;
    const { net } = netRt.mp;
    netRt.log.feed(e);
    if (e.type === 'settings') {
      if (e.circuitChanged && e.settings.circuit in TRACKS) {
        // the host moved the room: reload onto the circuit and come back with the same seat
        const id = e.settings.circuit as TrackId;
        saveSeat({ room: net.room, server: netRt.server, token: net.token });
        netStatus = { state: 'connecting', text: `The room is moving to ${TRACKS[id].name}: loading it…` };
        settings.track = id; saveSettings(settings);
        menu.refresh();
        netRt.mp.close('reload');
        location.href = roomUrl(net.room, netRt.server);
        return;
      }
      followRoomCar(net);
    }
    // the race is over: its results, in the menu's room tab
    if (e.type === 'session' && e.session.phase === 'race' && e.session.stage === 'results' && e.before.stage !== 'results') {
      if (!menu.isOpen) menu.open();
      menu.showTab('online');
    }
    menu.roomEvent(e);
  };
  const netHost: MenuHost['net'] = {
    status: () => netStatus,
    prefs: () => loadNetPrefs(),
    setPrefs: (p) => saveNetPrefs({ ...loadNetPrefs(), ...p }),
    create: (room) => { void enterRoom('create', room ?? null, serverFor()); },
    join: (text) => {
      const inv = parseInvite(text);
      if (inv) void enterRoom('join', inv.room, serverFor(inv.server));
    },
    retry: () => lastAttempt?.(),
    dismiss: () => { netStatus = { state: 'off', text: '' }; lastAttempt = null; history.replaceState(null, '', roomUrl(null)); menu.rebuild(); },
    leave: () => {
      const room = netRt?.mp.net.room ?? '';
      clearSeat(); lastAttempt = null;
      stopNet({ state: 'off', text: `You left room ${room}.` });
    },
    room: () => {
      if (!netRt) return null;
      const { mp, mod, server, log } = netRt;
      return { net: mp.net, kit: mod.lobby, log, server, invite: inviteUrl(mp.net.room, server), circuitName: (id) => (id in TRACKS ? TRACKS[id as TrackId].name : id),
        now: () => performance.now() / 1000 };
    },
    tyre: {
      options: () => session.car.compounds.map((c) => ({ id: c.id, name: c.name, letter: c.letter, colour: c.colour })),
      get: () => (startTyre && session.car.compounds.some((c) => c.id === startTyre) ? startTyre : session.car.compounds[0]?.id ?? ''),
      set: (id) => { startTyre = id; },
    },
  };

  // ---------------- Settings ----------------
  // What changing each setting does.
  const applySetting: { [K in SettingKey]: (v: Settings[K]) => void } = {
    // Track, walls, scenery, timing and minimap are all built once at startup, so another circuit means starting
    // again: setSetting has already saved the choice, and the reload picks it up.
    track: (id) => { if (id !== def.id) location.reload(); },
    car: (id) => {
      if (session.car.spec.id === id) return;
      session.setCar(CARS[id]);
      if (devRace?.compound) { fitDevCompound(session.car); session.restart(); }
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
    weather: (v) => { weather.quality = v; },
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
    net: netHost,
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
  if (booted) startNet(booted.mod, booted.net, booted.server);
  else if (bootError) menu.showTab('online');   // the link's room could not be entered: say why, and offer what to do

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
    session, timing, track, input, autopilot, brakeMarkers: stage.brakeMarkers, stage, mirror, weather,
    get multiplayer() { return netRt?.mp ?? null; },
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
    const nowS = now / 1000, running = started && !paused;
    if (netRt) {
      let fatal: { code: number; message: string } | null = null;
      for (const e of netRt.mp.update(nowS, !running)) {
        if (e.type === 'error' && e.fatal) fatal = { code: e.code, message: e.message };
        if (e.type === 'closed') { netClosed(e.reason, fatal); break; }
        onNetEvent(e);
        if (!netRt) break;   // (left: the page is reloading onto another circuit)
      }
      if (netRt) for (const n of netRt.mp.takeNotices()) netRt.board.notice(n);
      if (netRt && menu.isOpen && now - menuTick > 250) { menuTick = now; menu.refresh(); }   // the room tab's clocks
    }

    const padMenu = input.pollMenuPad();   // every frame, so a button held when the menu opens doesn't count
    if (menu.isOpen) for (const code of padMenu) menu.press(code);
    handleHotkeys();
    input.mouse.active = started && !paused && !menu.isOpen && !autoOn;

    if (running) {
      acc += fdt;
      let steps = 0;
      while (acc >= DT && steps < MAX_STEPS_PER_FRAME) {
        const inp = autoOn ? autopilot(session.car, track) : input.poll(DT);
        if (netRt) netRt.mp.tick(inp, autoOn, nowS - (acc - DT));   // (the local time this tick's state is for)
        else session.tick(inp, autoOn);
        acc -= DT; steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) acc = 0;
    } else netRt?.mp.idle(nowS);
    const alpha = clamp(acc / DT, 0, 1), car = session.car;
    car.render(alpha, paused ? 0 : fdt);
    for (const o of session.others) o.car.render(alpha, paused ? 0 : fdt);
    dust.update(paused ? 0 : fdt, car, camera, renderer);
    cam.lookBack = !menu.isOpen && input.lookingBack();
    cam.update(fdt, car);
    ghost.update(car, timing, session.simTime, alpha, camera);
    // other players at the time the car is drawn at (it is interpolated a tick behind the physics)
    if (netRt) netRt.view.update(netRt.mp, nowS - DT, camera, paused ? 0 : fdt, !hud.hidden && !menu.isOpen);
    cockpitDisplay.update(car, timing, session.simTime, alpha, cam.mode === 'driver' && !cam.lookBack);
    if (devWeather) weather.set(devWeather);
    weather.update(paused ? 0 : fdt, cam, session, netRt?.view);
    audio.update(car, fdt, started && !paused);

    hud.handleEvents(timing);
    hud.update({ car, timing, simTime: session.simTime, alpha, dt: fdt, autoOn, paused, mouseSteer: input.mouse.enabled ? input.mouse.steer : null, ghost: ghost.shown ? ghost.mapPos : null,
      others: netRt?.view.dots, netGhost: netRt?.mp.noCollide });
    if (netRt && !hud.hidden) netRt.board.update(netRt.mp, netRt.view.status, fdt, !running);

    renderer.render(scene, camera);
    const cockpitView = cam.mode === 'onboard' || cam.mode === 'driver';
    mirror.render(renderer, scene, stage.sun, car, mirror.wanted(cockpitView) && !hud.hidden && !menu.isOpen && !cam.lookBack, ghost, camera);
  };
  requestAnimationFrame(frame);
  // A hidden tab gets no frames: keep a room's connection alive meanwhile (the relay drops a client it has not heard
  // from for 10 s), with the car sent as paused (the simulation is stopped too: frames cap their time step).
  setInterval(() => {
    const t = performance.now();
    if (!netRt || t - last < 500) return;
    for (const e of netRt.mp.update(t / 1000, true)) {
      if (e.type === 'closed') { netClosed(e.reason, null); return; }
      onNetEvent(e);
      if (!netRt) return;
    }
    netRt.mp.idle(t / 1000);
  }, 1000);
}

// The player's name in rooms: the saved one, or one made up (and saved) the first time.
function netName(): string {
  const p = loadNetPrefs();
  if (p.name.trim()) return p.name.trim();
  const name = randomName();
  saveNetPrefs({ ...p, name });
  return name;
}

// The ?opponents value: a count of the player's car (none given: one), or car ids separated by commas (unknown ids
// are skipped).
function opponentCars(value: string | null, player: CarId): CarId[] {
  if (value == null) return [];
  const n = value === '' ? 1 : Number(value);
  if (Number.isInteger(n)) return Array<CarId>(Math.max(0, Math.min(n, 12))).fill(player);
  return value.split(',').map((v) => v.trim()).filter((v): v is CarId => v in CARS);
}
