import { allCircuits, type CircuitInfo } from './catalog';
import { CARS, hasAssist, type CarId } from './cars';
import { $ } from './dom';
import { ACTION_KEYS, ACTIONS, keyLabel, MENU_KEY, type Action, type Bindings, type Slot } from './keys';
import { SECTIONS, SETTING_DEFS, SETTING_KEYS, optionText, type SettingKey, type SettingSection, type Settings } from './settings';
import { TRACKS, type TrackId } from './tracks';
import type { JoinOffer, ResultRow, RoomField, RoomLog, RoomValue } from './lobby';
import type { NetClient, RoomSettings } from './net';
import { defaultServer, parseInvite, validServer, type NetPrefs } from './netPrefs';
import { clamp, fmtTime, wrapI } from './util';

// ============================================================================
// Main / pause menu. A header with the main action (Drive, or Resume and Restart lap), then four tabs: Time trial
// (car and circuit cards), Online (create or join a room; in a room, the tab is the room: invite, session, drivers,
// results, your car, the weekend's settings, the circuit), Settings (one section at a time) and Controls (steering
// devices, key bindings, mouse and gamepad). In a room the Time trial tab is gone: the room decides the circuit.
// Mouse, keyboard (↑ ↓ move, ← → change, Enter select, Esc back) or gamepad (d-pad, A, B, LB / RB tabs).
// It talks to the game only through MenuHost; the room's own module (lobby.ts) and its NetClient come through
// MenuHost.net.room(), so the menu itself imports no networking code (types only).
// ============================================================================
export interface MenuHost {
  readonly settings: Readonly<Settings>;
  readonly loadedTrack: TrackId;       // the circuit built at startup (choosing another reloads the page)
  started(): boolean;                   // false before the first Drive: shows Drive instead of Resume / Restart
  bestLap(track: TrackId, car: CarId): number | null;
  setSetting<K extends SettingKey>(key: K, value: Settings[K]): void;
  cycleSetting(key: SettingKey, dir?: number): void;
  resetSettings(): void;                // every setting but car and circuit back to its default
  bindings(): Readonly<Bindings>;
  rebind(action: Action, slot: Slot, code: string | null): void;
  resetBindings(): void;
  restart(): void;
  resetBestTimes(): void;               // the current car at the current circuit
  onOpen(): void;
  onClose(): void;
  readonly net: NetHost;                // multiplayer (the Online tab)
}

// ---------------- Multiplayer, as the menu sees it ----------------
// off: not in a room (text: why it was left, if it was); connecting; joined; error (text: what went wrong, offer:
// the one thing to do about it, room: the room it was about).
export interface NetStatus { state: 'off' | 'connecting' | 'joined' | 'error'; text: string; offer?: JoinOffer; room?: string }
export interface NetHost {
  status(): NetStatus;
  prefs(): NetPrefs;                    // name and relay (server: '' = the default) as saved
  setPrefs(p: Partial<NetPrefs>): void; // saved as typed
  create(room?: string): void;          // open a room (a made-up code, or this one: the link of a room that closed)
  join(invite: string): void;           // a room code or an invite link
  retry(): void;                        // the last room tried again (rejoining with this tab's seat)
  dismiss(): void;                      // forget the error (and a room link that failed)
  leave(): void;
  room(): RoomView | null;              // joined: the room, read straight from its NetClient
  raceGoesOn(): boolean;                // a race we are in: it does not stop while the menu is open (our car is parked)
  // The starting tyre for the room's sessions (Weekend.setStartCompound fits it whenever a session puts the car on track).
  readonly tyre: TyreChoice | null;
}
export interface RoomView {
  readonly net: NetClient;              // players, host, isHost, settings, session, standings, board (read only here)
  readonly kit: LobbyKit;               // src/lobby.ts, loaded with the networking code
  readonly log: RoomLog;                // what the menu keeps between events (the last qualifying)
  readonly server: string;              // the relay
  readonly invite: string;              // the link to send others
  readonly circuitName: (id: string) => string;
  now(): number;                        // local clock (s) for net.serverTime / sample
}
export interface TyreChoice {
  options(): { id: string; name: string; letter: string; colour: string }[];   // the current car's compounds
  get(): string | null;                 // null: Auto (the weather and the session decide)
  set(id: string | null): void;
}
type LobbyKit = typeof import('./lobby');

type Tab = 'race' | 'online' | 'settings' | 'controls';
type Armed = 'best' | 'settings' | 'keys' | 'leave' | 'skip' | 'abort' | 'circuit';

// One stop for ↑ ↓. cycle: what ← → do on it; update: bring it in line with the settings after a change.
interface MenuItem { el: HTMLElement; target?: () => HTMLElement; run?: () => void; cycle?: (dir: number) => void; update?: () => void }

// Rows that only matter with mouse steering; dimmed while steering by keyboard (so is the assist row on a car without one).
const MOUSE_ROWS: SettingKey[] = ['mouseSens', 'mouseDeadzone', 'mouseBar'];
const SEARCH_FROM = 7;   // circuits: a search box once there are this many

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
}
function button(cls: string, text = '') { const b = h('button', cls, text); b.type = 'button'; return b; }

export class Menu {
  isOpen = true;                        // the page opens on the menu
  private readonly overlay = $('overlay');
  private readonly menuEl = $('menu');
  private readonly actionsEl = $('menuActions');
  private readonly tabsEl = $('menuTabs');
  private readonly contentEl = $('menuContent');
  private readonly body = $('menuBody');
  private items: MenuItem[] = [];
  private focus = 0;                    // item ↑ ↓ move from; follows real focus (Tab, clicks)
  private tab: Tab = 'race';
  private section: SettingSection = 'driving';
  private query = '';
  private armed: Armed | null = null;   // a reset link clicked once (a second click within 3 s does it)
  private armTimer = 0;
  private capture: { action: Action; slot: Slot } | null = null;   // waiting for the key to bind
  private extraUpdates: (() => void)[] = [];   // updates of elements that are not stops for ↑ ↓
  private relayOpen = false;            // the relay address field shown (it is, too, when the address is not the default)
  private joinText = '';                // what the Join field holds (kept across rebuilds)
  // The host's settings changes not yet echoed by the relay: shown at once, and merged into the next change (the
  // relay takes the settings whole). Dropped once every change sent has come back, or after 2 s.
  private pending: Partial<RoomSettings> = {};
  private pendingN = 0;
  private pendingAt = 0;
  private armedCircuit = '';            // the circuit card clicked once (the host moving the room)
  private copied = 0;                   // performance.now() of the last copy of the invite link
  private moreOpen = false;             // the host's weekend: "More options" shown
  private circuitsOpen = false;         // the host's room tab: every circuit shown, not just the room's

  constructor(private readonly host: MenuHost) {
    addEventListener('keydown', (e) => this.onKey(e));
    this.overlay.addEventListener('focusin', (e) => {
      const k = this.items.findIndex((it) => it.el.contains(e.target as Node));
      if (k >= 0) this.focus = k;
    });
    // a click anywhere else gives up on rebinding
    addEventListener('pointerdown', (e) => {
      if (this.capture && !(e.target as Element).closest?.('.keycap.capturing')) { this.capture = null; this.build(); }
    }, true);
  }

  // Hide the loading text and show the menu itself.
  show() { $('loadState').hidden = true; this.body.hidden = false; this.build(); }
  refresh() { if (this.isOpen && !this.body.hidden) this.update(); }
  rebuild() { if (this.isOpen && !this.body.hidden) this.build(); }
  // Switch to a tab (e.g. the room's, on joining), rebuilding if the menu is showing.
  showTab(t: 'race' | 'online') { this.tab = t; this.focus = 0; this.contentEl.scrollTop = 0; this.rebuild(); }

  // A room event (main.ts passes them all): the host's settings coming back, and what changes the room tab's
  // structure (the host role, a session starting or ending) rebuilds it; the rest only updates.
  roomEvent(e: { type: string; session?: { phase: string }; before?: unknown }) {
    if (e.type === 'settings' && --this.pendingN <= 0) { this.pending = {}; this.pendingN = 0; }
    if (!this.isOpen || this.body.hidden || this.tab !== 'online') return;
    const phaseChanged = e.type === 'session' && (e.before as { phase: string }).phase !== e.session!.phase;
    if (phaseChanged) this.contentEl.scrollTop = 0;   // the session box, at the top, is what changed
    if (e.type === 'host' || e.type === 'welcome' || phaseChanged) this.build();
    else if (e.type !== 'state' && e.type !== 'contact') this.update();
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true; this.focus = 0; this.armed = null; this.capture = null;
    this.contentEl.scrollTop = 0;       // (from the top: in a room, the session box)
    this.overlay.classList.remove('hidden');
    this.host.onOpen();
    this.show();                        // also when the page skipped the menu (?autopilot) and it was never shown
  }

  close() {
    this.isOpen = false; this.capture = null; this.overlay.classList.add('hidden');
    // drop focus so a held key can't press a button while the menu fades out
    if (this.overlay.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    this.host.onClose();
  }

  // A gamepad button, as the key it stands for (Input.pollMenuPad).
  press(code: string) {
    if (!this.isOpen || this.body.hidden) return;
    if (code === 'TabPrev' || code === 'TabNext') { this.switchTab(code === 'TabNext' ? 1 : -1); return; }
    this.handle(code, false, true);
  }

  // ---------------- Building ----------------

  private hasFocus() { const a = document.activeElement; return a instanceof HTMLElement && this.menuEl.contains(a) && a !== document.body; }

  // Rebuild everything (tab change, opening, bindings). Settings changes only update() the existing elements, so a
  // slider being dragged isn't replaced under the pointer.
  private build() {
    const hadFocus = this.hasFocus();
    this.items = []; this.extraUpdates = [];
    this.buildActions();
    this.buildTabs();
    this.contentEl.innerHTML = '';
    this.contentEl.dataset.tab = this.tab;
    if (this.tab === 'race') this.buildRace();
    else if (this.tab === 'online') { const room = this.host.net.room(); if (room) this.buildRoom(room); else this.buildWayIn(); }
    else if (this.tab === 'settings') this.buildSettings();
    else this.buildControls();
    this.update();
    this.focus = clamp(this.focus, 0, this.items.length - 1);
    if (hadFocus) {
      while (this.focus > 0 && !this.shown(this.items[this.focus])) this.focus--;
      this.target(this.items[this.focus]).focus({ preventScroll: true });
    }
  }

  private update() {
    const { host } = this, car = CARS[host.settings.car], track = TRACKS[host.loadedTrack], room = host.net.room();
    // (a race does not pause: say so, and that the car is stopped where it is)
    const raceOn = host.net.raceGoesOn(), badge = $('menuPaused');
    badge.hidden = !host.started() && !raceOn;
    badge.textContent = raceOn ? 'Race on · your car is stopped' : 'Paused';
    badge.classList.toggle('live', raceOn);
    $('menuSub').textContent = room
      ? `Room ${room.net.room} · ${room.kit.sessionTitle(room.net.session, room.net.settings)} · ${car.name} at ${track.name}`
      : `Time trial · ${car.name} at ${track.name}`;
    for (const it of this.items) it.update?.();
    for (const u of this.extraUpdates) u();
  }

  // Whether an item is on screen (not hidden itself or inside something hidden): ↑ ↓ skip the others.
  private shown(it: MenuItem) { return it.el.isConnected && !it.el.closest('[hidden]'); }

  private tabs(): [Tab, string][] {
    const inRoom = !!this.host.net.room();
    return [...(inRoom ? [] : [['race', 'Time trial'] as [Tab, string]]), ['online', inRoom ? 'Room' : 'Online'], ['settings', 'Settings'], ['controls', 'Controls']];
  }

  // ---------------- Online tab: the way in ----------------

  // A text field as a stop for ↑ ↓ (Enter: `enter`). Typing updates the menu (buttons enabled, hints).
  private textField(parent: HTMLElement, value: string, attrs: Record<string, string>, enter?: () => void) {
    const input = h('input');
    input.type = 'text'; input.value = value; input.spellcheck = false; input.autocomplete = 'off';
    for (const [k, v] of Object.entries(attrs)) input.setAttribute(k, v);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); enter?.(); } });
    input.addEventListener('input', () => this.update());
    parent.append(input);
    this.items.push({ el: input, run: enter });
    return input;
  }

  // Not in a room: your name, Create room, Join room (a code or a link), what went wrong and what to do about it,
  // and the relay's address (hidden unless opened or not the default).
  private buildWayIn() {
    const { host } = this, c = this.contentEl, prefs = host.net.prefs(), track = TRACKS[host.loadedTrack];
    // what happened, and the one thing to do about it
    const status = h('div', 'netstatus'), stText = h('p', ''), offers = h('div', 'offers');
    status.append(stText, offers); c.append(status);
    const busy = () => host.net.status().state === 'connecting';
    const offer = (label: () => string, show: (s: NetStatus) => boolean, run: () => void, primary = false) => {
      const bt = button('mbtn' + (primary ? ' primary' : ''));
      bt.addEventListener('click', run);
      offers.append(bt);
      this.items.push({ el: bt, run, update: () => { const s = host.net.status(); bt.hidden = !show(s); bt.textContent = label(); } });
    };
    offer(() => 'Reload the page', (s) => s.offer === 'reload', () => location.reload(), true);
    offer(() => `Open room ${host.net.status().room ?? ''}`, (s) => s.offer === 'create' && !!s.room, () => host.net.create(host.net.status().room), true);
    offer(() => 'Try again', (s) => s.offer === 'retry', () => host.net.retry());
    offer(() => 'Back to time trial', (s) => s.state === 'error', () => { host.net.dismiss(); this.setTab('race'); });
    this.extraUpdates.push(() => {
      const s = host.net.status();
      status.className = 'netstatus ' + s.state;
      status.hidden = !s.text;
      stText.textContent = s.text;
      offers.hidden = s.state !== 'error';
    });

    c.append(h('p', 'mintro', 'Drive with friends: one of you opens a room and sends the others its code or link. Everyone in a room drives the same circuit, and the host can run a race weekend: practice, qualifying and a race.'));

    const nameRow = h('label', 'nrow');
    nameRow.append(h('span', 'nlabel', 'Your name'));
    const name = this.textField(nameRow, prefs.name, { maxlength: '16', placeholder: 'Your name', 'aria-label': 'Your name', autocomplete: 'nickname' });
    name.addEventListener('input', () => host.net.setPrefs({ name: name.value.trim() }));
    nameRow.append(h('small', 'mnote', 'Shown to the others. Remembered in this browser.'));
    c.append(nameRow);

    const ways = h('div', 'ways'); c.append(ways);
    const make = h('section', 'way');
    make.append(h('h3', '', 'Create a room'), h('p', '', `It opens at ${track.name}. You are the host: you choose the circuit and the race, then invite the others.`));
    const createBt = button('mbtn primary', 'Create room');
    const create = () => { if (!busy()) host.net.create(); };
    createBt.addEventListener('click', create);
    make.append(createBt);
    ways.append(make);
    this.items.push({ el: createBt, run: create, update: () => { createBt.disabled = busy(); } });

    const join = h('section', 'way');
    join.append(h('h3', '', 'Join a room'), h('p', '', 'Type the code the host gave you, or paste their invite link.'));
    const jrow = h('div', 'jrow'); join.append(jrow);
    const go = () => { this.joinText = code.value; if (!busy() && parseInvite(code.value)) host.net.join(code.value); };
    const code = this.textField(jrow, this.joinText, { placeholder: 'Code or link', 'aria-label': 'Room code or invite link', autocapitalize: 'characters', enterkeyhint: 'go' }, go);
    code.classList.add('code');
    code.addEventListener('input', () => { this.joinText = code.value; });
    const joinBt = button('mbtn', 'Join');
    joinBt.addEventListener('click', go);
    jrow.append(joinBt);
    const hint = h('p', 'hint'); join.append(hint);
    ways.append(join);
    this.items.push({ el: joinBt, run: go, update: () => {
      const typed = code.value.trim();
      joinBt.disabled = busy() || !parseInvite(typed);
      hint.textContent = typed && !parseInvite(typed) ? 'A room code is up to 8 letters and digits, like K7QX.' : '';
    } });

    // the relay: an advanced detail
    const relayRow = h('div', 'relay'); c.append(relayRow);
    const relayNote = h('span', 'mnote');
    const change = button('link', 'Change');
    const openRelay = () => { this.relayOpen = true; this.update(); relay.focus(); };
    change.addEventListener('click', openRelay);
    relayRow.append(relayNote, change);
    const relayField = h('label', 'nrow'); c.append(relayField);
    relayField.append(h('span', 'nlabel', 'Relay address'));
    const relay = this.textField(relayField, prefs.server || defaultServer(), { placeholder: defaultServer(), 'aria-label': 'Relay address', inputmode: 'url' });
    relay.addEventListener('input', () => {
      const v = relay.value.trim();
      if (!v || validServer(v)) host.net.setPrefs({ server: v === defaultServer() ? '' : v });
    });
    const useDefault = button('link', 'Use the default');
    const reset = () => { relay.value = defaultServer(); host.net.setPrefs({ server: '' }); this.update(); };
    useDefault.addEventListener('click', reset);
    relayField.append(useDefault);
    const relayHint = h('p', 'hint'); relayField.append(relayHint);
    this.extraUpdates.push(() => { relayHint.textContent = relay.value.trim() && !validServer(relay.value) ? 'A relay address starts with ws:// or wss://.' : ''; });
    this.items.push({ el: change, run: openRelay }, { el: useDefault, run: reset, update: () => {
      const custom = !!host.net.prefs().server, open = this.relayOpen || custom;
      relayRow.hidden = open; relayField.hidden = !open;
      useDefault.hidden = !custom;
      relayNote.textContent = `Relay: ${defaultServer().replace(/^wss?:\/\//, '')} (the default) · `;
      relay.disabled = busy();
    } });

    this.heading('How it works');
    const how = h('ul', 'how'); c.append(how);
    for (const t of ['In the lobby everyone drives freely, with a board of best laps.',
      'The host picks a race format and starts the weekend: practice, qualifying and the race, timed for everyone at once.',
      'After the race the results stay in the lobby until the next weekend starts.',
      'Your own best laps and ghost are kept in this browser, as in time trial.']) how.append(h('li', '', t));
  }

  // ---------------- Online tab: in a room ----------------

  // The room's settings as shown: the relay's, with the host's changes still on their way on top.
  private roomSettings(r: RoomView): RoomSettings {
    if (this.pendingN > 0 && performance.now() - this.pendingAt > 2000) { this.pending = {}; this.pendingN = 0; }
    return this.pendingN > 0 ? r.kit.normaliseSettings({ ...r.net.settings, ...this.pending }) : r.net.settings;
  }
  private setRoom(r: RoomView, patch: Partial<RoomSettings>) {
    if (!r.net.isHost || r.net.session.phase !== 'lobby') return;
    this.pending = { ...this.pending, ...patch }; this.pendingN++; this.pendingAt = performance.now();
    r.net.setSettings(this.roomSettings(r));
    this.update();
  }

  // The room tab. In the lobby: the room (code, invite), the session box (Start weekend), the last results and the
  // lobby's board, the weekend (the host's formats and options; everyone else a summary), the drivers, your car, the
  // circuit. During a weekend: the session, the times, the drivers, your car, the weekend's summary, the circuit and
  // the room.
  private buildRoom(r: RoomView) {
    const { host } = this, c = this.contentEl, { net, kit } = r;
    const lobby = net.session.phase === 'lobby', isHost = net.isHost, editable = isHost && lobby;
    const hostName = () => net.players.get(net.host)?.name ?? 'the host';

    // --- the room: its code, the invite, leaving (during a weekend, under the session: that matters more then)
    const cardItems = this.items.length;
    const card = h('section', 'roomcard'); c.append(card);
    const codeBox = h('div', 'rcode');
    codeBox.append(h('span', 'rlabel', 'Room code'), h('b', 'roomcode num', net.room));
    const meta = h('span', 'rmeta'); codeBox.append(meta);
    const inv = h('div', 'rinvite');
    const link = h('input', 'invite num');
    link.readOnly = true; link.value = r.invite; link.setAttribute('aria-label', 'Invite link');
    link.addEventListener('focus', () => link.select());
    const btns = h('div', 'rbtns');
    const copy = button('mbtn primary copy', 'Copy invite link');
    copy.addEventListener('click', () => this.copyInvite(link));
    btns.append(copy);
    this.items.push({ el: copy, run: () => this.copyInvite(link), update: () => {
      const done = performance.now() - this.copied < 2000;
      copy.textContent = done ? 'Link copied' : 'Copy invite link'; copy.classList.toggle('done', done);
    } });
    if (typeof navigator.share === 'function') {
      const share = button('mbtn', 'Share…');
      const run = () => { navigator.share({ title: 'Fast Roads', text: `Race me in Fast Roads: room ${net.room}`, url: r.invite }).catch(() => {}); };
      share.addEventListener('click', run);
      btns.append(share);
      this.items.push({ el: share, run });
    }
    inv.append(btns, link);
    this.items.push({ el: link });
    card.append(codeBox, inv);
    const leave = h('div', 'rleave'); card.append(leave);
    this.resetLink('leave', 'Leave room', () => host.net.leave(), leave, () => true, 'link', 'Click again to leave the room');
    const cardEnd = this.items.length;
    this.extraUpdates.push(() => {
      const ms = net.rtt > 0 ? ` · ${Math.round(net.rtt * 1000)} ms to the relay` : '';
      meta.textContent = (isHost ? 'You are the host' : `Host: ${hostName()}`) + ms;
    });

    // --- the session: what is on, how long is left, what comes next; the host's controls
    const sess = h('section', 'sessbox'); c.append(sess);
    const sTitle = h('h3', 'stitle'), line = h('div', 'sline'), sBig = h('b', 'sbig num'), sText = h('span', 'stext'), sNext = h('p', 'snext');
    line.append(sBig, sText); sess.append(sTitle, line, sNext);
    this.extraUpdates.push(() => {
      const se = net.session, s = this.roomSettings(r), st = kit.sessionState(se, s, net.serverTime(r.now()), net.standings[0]?.laps ?? 0);
      sTitle.textContent = kit.sessionTitle(se, s);
      sBig.textContent = st.big ?? ''; sBig.hidden = !st.big; sText.textContent = st.text;
      sNext.textContent = kit.nextSession(se, s);   // (in the lobby the weekend itself follows: the host's options or its summary)
    });
    if (lobby && isHost) {
      const start = button('mbtn primary start', 'Start weekend');
      const go = () => net.startWeekend();
      start.addEventListener('click', go);
      sess.append(start);
      this.items.push({ el: start, run: go });
    } else if (lobby) {
      const wait = h('p', 'swait'); sess.append(wait);
      this.extraUpdates.push(() => { wait.textContent = `Waiting for ${hostName()} to start the weekend.`; });
    } else if (isHost) {
      const ctl = h('div', 'sctl'); sess.append(ctl);
      this.resetLink('skip', kit.skipLabel(net.session), () => net.skipSession(), ctl, () => true, 'mbtn', 'Click again to confirm');
      this.resetLink('abort', 'Abort the weekend', () => net.abortWeekend(), ctl, () => net.session.stage !== 'results', 'mbtn',
        'Click again: back to the lobby, no result');
      this.extraUpdates.push(() => {
        const skip = ctl.querySelector<HTMLElement>('button');
        const label = kit.skipLabel(net.session);
        if (skip) skip.textContent = this.armed === 'skip' ? `Click again to ${label[0].toLowerCase()}${label.slice(1)}` : label;
      });
    }

    // --- times: the session's board or the race's order; the last weekend's results in the lobby
    const times = h('section', 'times'); c.append(times);
    let timesHtml = '';
    this.extraUpdates.push(() => {
      const html = this.timesHtml(r);
      if (html !== timesHtml) { times.innerHTML = timesHtml = html; }
      times.hidden = !html;
    });

    // --- the weekend: the host's formats and options in the lobby; a summary for everyone else
    if (editable) this.weekendEditor(r);
    else if (lobby) this.weekendFacts(r, () => `The weekend · set by ${hostName()}`);

    // --- drivers
    const dh = this.heading('Drivers');
    const list = h('ul', 'drivers'); c.append(list);
    let listHtml = '';
    this.extraUpdates.push(() => {
      dh.textContent = `Drivers · ${net.players.size} of ${net.maxPlayers}`;
      const now = r.now(), race = net.session.phase === 'race';
      const html = [...net.players.values()].map((p) => {
        const st = kit.playerState(net, p.id, now), slot = race ? net.gridSlot(p.id) : null;
        const tags = (p.id === net.host ? '<em class="tag host">Host</em>' : '') + (p.id === net.selfId ? '<em class="tag you">You</em>' : '');
        return `<li class="${p.id === net.selfId ? 'self' : ''} st-${st}"><b>${esc(p.name)}</b>${tags}<span class="dcar">${esc(carLabel(p.car))}</span>`
          + `<span class="dstate">${[slot != null ? `P${slot + 1} on the grid` : '', st === 'you' ? '' : kit.PLAYER_STATE_TEXT[st]].filter(Boolean).join(' · ')}</span></li>`;
      }).join('');
      if (html !== listHtml) list.innerHTML = listHtml = html;
    });

    // --- your car (and starting tyres)
    this.heading('Your car');
    // (a car change puts the car back at the start: in a race, or one-shot qualifying's single lap, that is not allowed)
    const locked = () => (net.session.phase === 'race' && net.session.stage !== 'results' ? 'the race'
      : net.session.phase === 'qualifying' && net.session.oneShot ? 'one-shot qualifying' : null);
    const carNote = h('p', 'mnote carnote'); c.append(carNote);
    this.extraUpdates.push(() => {
      const only = this.roomSettings(r).car, during = locked();
      carNote.textContent = only ? `Everyone in this room races the ${carLabel(only)}${editable ? ' (Cars, under Race weekend, opens it to any car)' : isHost ? ': you chose it' : `: ${hostName()}, the host, chose it`}.`
        : during ? `Cars cannot be changed during ${during}.` : 'Any car: pick yours.';
    });
    this.carCards(c, (id) => {
      const only = this.roomSettings(r).car, during = locked();
      if (only && only !== id) return `This room races the ${carLabel(only)} only`;
      return during ? `Cars cannot be changed during ${during}` : null;
    }, 'Your best here in race conditions');
    if (host.net.tyre) this.tyreRow(host.net.tyre);

    if (!lobby) this.weekendFacts(r, () => 'The weekend');

    // --- the circuit: the room's, and (the host, in the lobby) the others behind "Change circuit"
    const head = h('div', 'mh-row'); c.append(head);
    this.heading('Circuit', head);
    if (editable) {
      const toggle = button('link', this.circuitsOpen ? 'Hide the other circuits' : 'Change circuit…');
      const flip = () => { this.circuitsOpen = !this.circuitsOpen; this.build(); };
      toggle.addEventListener('click', flip);
      head.append(toggle);
      this.items.push({ el: toggle, run: flip });
      this.circuitCards(head, (info) => info.id === this.roomSettings(r).circuit, (info, bt, best) => {
        if (info.id === this.roomSettings(r).circuit) return;
        if (this.armedCircuit !== info.id) { this.arm('circuit'); this.armedCircuit = info.id; best.textContent = 'Click again: everyone moves here'; return; }
        this.armed = null; bt.classList.add('loading'); best.textContent = 'Moving the room…';
        this.setRoom(r, kit.withCircuit(this.roomSettings(r), info.id));
      }, () => false, (info) => this.circuitsOpen || info.id === net.settings.circuit);
      if (this.circuitsOpen) c.append(h('p', 'mnote', 'Another circuit moves everyone in the room there: each game reloads onto it, and the board starts again.'));
    } else {
      this.circuitCards(head, () => true, () => {}, () => true, (info) => info.id === net.settings.circuit);
      c.append(h('p', 'mnote', isHost ? 'The circuit can change in the lobby, after the weekend.' : `${hostName()} (the host) chooses the circuit.`));
    }

    if (!lobby) {   // during a weekend the session comes first, the invite last
      c.append(card);
      const moved = this.items.splice(cardItems, cardEnd - cardItems);
      this.items.push(...moved);
    }
  }

  // The host's weekend in the lobby: a card for each format (what it is, what it sets here), the options that matter
  // most, and the rest behind "More options", in groups.
  private weekendEditor(r: RoomView) {
    const c = this.contentEl, kit = r.kit;
    const box = h('section', 'wkbox'); c.append(box);
    const head = h('div', 'mh-row');
    head.append(h('h2', 'mh', 'Race weekend'), h('span', 'mnote', 'Choose a format, change anything you like. Everyone sees it at once.'));
    box.append(head);
    const grid = h('div', 'cards presets'); box.append(grid);
    const apply = (p: (typeof kit.PRESETS)[number]) => this.setRoom(r, kit.withPreset(this.roomSettings(r), p));
    const cards = kit.PRESETS.map((p) => {
      const bt = button('card pcard');
      const name = h('b', 'cname', p.name), tag = h('em', 'ptag', 'Changed'), blurb = h('span', 'cblurb', p.blurb), sum = h('span', 'cfacts');
      bt.append(name, tag, blurb, sum);
      bt.addEventListener('click', () => apply(p));
      grid.append(bt);
      return { p, bt, sum, tag };
    });
    const custom = h('p', 'mnote pnote'); box.append(custom);
    const exact = () => kit.presetOf(this.roomSettings(r)), near = () => exact() ?? kit.closestPreset(this.roomSettings(r));
    this.items.push({ el: grid, target: () => cards.find((k) => k.p === near())!.bt,
      run: () => apply(near()),
      cycle: (dir) => {
        const ps = kit.PRESETS, next = ps[wrapI(ps.indexOf(near()) + dir, ps.length)];
        apply(next);
        cards.find((x) => x.p === next)!.bt.focus();
      },
      update: () => {
        const s = this.roomSettings(r), e = exact(), nr = near();
        for (const k of cards) {
          k.bt.classList.toggle('sel', k.p === e); k.bt.classList.toggle('near', !e && k.p === nr);
          k.bt.setAttribute('aria-pressed', String(k.p === e));
          k.tag.hidden = !!e || k.p !== nr;
          k.sum.textContent = kit.presetSummary(k.p, s);
        }
        custom.textContent = e ? '' : `Custom: ${nr.name} with changes. Choose ${nr.name} again to go back to its options.`;
      } });

    const main = h('div', 'menu-settings wkrows'); box.append(main);
    for (const f of kit.ROOM_FIELDS) if (f.group === 'main') this.roomRow(r, f, main, true);

    const more = button('mbtn more');
    const moreBox = h('div', 'moreopts');
    const flip = () => { this.moreOpen = !this.moreOpen; this.update(); };
    more.addEventListener('click', flip);
    box.append(more, moreBox);
    this.items.push({ el: more, run: flip, update: () => {
      more.textContent = this.moreOpen ? 'Fewer options' : 'More options: practice, tyres and pit stops, rules';
      more.setAttribute('aria-expanded', String(this.moreOpen));
      moreBox.hidden = !this.moreOpen;
    } });
    for (const [g, label] of kit.FIELD_GROUPS) {
      if (g === 'main') continue;
      moreBox.append(h('h4', 'mh2', label));
      const rows = h('div', 'menu-settings wkrows'); moreBox.append(rows);
      for (const f of kit.ROOM_FIELDS) if (f.group === g) this.roomRow(r, f, rows, true);
    }
  }

  // The weekend as plain text: for everyone but the host in the lobby, and for all during the weekend.
  private weekendFacts(r: RoomView, title: () => string) {
    const c = this.contentEl;
    const head = this.heading(title());
    const dl = h('dl', 'ref facts'); c.append(dl);
    let html = '';
    this.extraUpdates.push(() => {
      head.textContent = title();
      const next = r.kit.weekendFacts(this.roomSettings(r)).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
      if (next !== html) dl.innerHTML = html = next;
    });
  }

  // A weekend setting for the host in the lobby: buttons, or − value + for numbers with many steps.
  private roomRow(r: RoomView, f: RoomField, parent: HTMLElement, editable: boolean) {
    const kit = r.kit;
    const row = h('div', 'mrow'); row.tabIndex = -1;
    const hint = h('small', '', f.hint);
    const lab = h('div', 'mlabel'); lab.append(h('span', '', f.label), hint);
    row.append(lab);
    if (f.detail) { const d = f.detail; this.extraUpdates.push(() => { hint.textContent = `${f.hint} ${d(this.roomSettings(r))}`; }); }
    const cur = () => this.roomSettings(r)[f.key];
    const set = (v: RoomValue) => { if (editable && v !== cur()) this.setRoom(r, { [f.key]: v } as Partial<RoomSettings>); };
    const cycle = (dir: number) => set(kit.stepOption(f, cur(), dir, this.roomSettings(r), f.kind === 'choice'));
    let target: () => HTMLElement, sync: () => void;
    if (f.kind === 'choice') {
      const seg = h('div', 'seg wrap');
      const bts = f.options.map(([v, text]) => {
        const bt = button('', text);
        bt.addEventListener('click', () => set(v));
        seg.append(bt); return [v, bt] as const;
      });
      row.append(seg);
      target = () => bts.find(([v]) => v === cur())?.[1] ?? row;
      sync = () => {
        const s = this.roomSettings(r);
        for (const [v, bt] of bts) {
          const on = v === s[f.key];
          bt.classList.toggle('on', on); bt.setAttribute('aria-pressed', String(on));
          bt.disabled = !!f.allowed && !f.allowed(v, s);
        }
      };
    } else {
      const wrap = h('div', 'stepper'), minus = button('', '−'), out = h('output', 'num'), plus = button('', '+');
      minus.setAttribute('aria-label', `Less: ${f.label}`); plus.setAttribute('aria-label', `More: ${f.label}`);
      minus.addEventListener('click', () => cycle(-1)); plus.addEventListener('click', () => cycle(1));
      wrap.append(minus, out, plus); row.append(wrap);
      target = () => row;
      sync = () => {
        const v = cur(), s = this.roomSettings(r);
        out.textContent = f.shown ? f.shown(s) : kit.optionLabel(f, v);
        minus.disabled = kit.stepOption(f, v, -1, s) === v;
        plus.disabled = kit.stepOption(f, v, 1, s) === v;
      };
    }
    parent.append(row);
    this.items.push({ el: row, target, cycle, run: () => cycle(1),
      update: () => { sync(); row.classList.toggle('dim', !!f.applies && !f.applies(this.roomSettings(r))); } });
  }

  // Starting tyres: Auto, then the current car's compounds (rebuilt when the car changes; hidden with one compound).
  private tyreRow(t: TyreChoice) {
    const { host } = this;
    const rows = h('div', 'menu-settings tyrerow'); this.contentEl.append(rows);
    const row = h('div', 'mrow');
    const lab = h('div', 'mlabel'); lab.append(h('span', '', 'Starting tyres'),
      h('small', '', 'Fitted when each session puts you on track. Auto: soft in practice and qualifying, medium in the race, intermediates or wets on a wet track.'));
    const seg = h('div', 'seg'); row.append(lab, seg); rows.append(row);
    let car = '', bts: (readonly [string | null, HTMLButtonElement])[] = [];
    const fill = () => {
      car = host.settings.car; seg.innerHTML = '';
      const opts = t.options();
      bts = [{ id: null, name: 'Auto', colour: '' }, ...opts].map((o) => {
        const bt = button('', o.name);
        if (o.colour) bt.style.setProperty('--tc', o.colour);
        bt.addEventListener('click', () => { t.set(o.id); this.update(); });
        seg.append(bt); return [o.id, bt] as const;
      });
      if (opts.length < 2) bts = [];
    };
    this.items.push({ el: row, target: () => bts.find(([id]) => id === t.get())?.[1] ?? bts[0]?.[1] ?? row,
      cycle: (dir) => { const k = bts.findIndex(([id]) => id === t.get()); if (bts.length) { t.set(bts[wrapI(k + dir, bts.length)][0]); this.update(); } },
      update: () => {
        if (car !== host.settings.car) fill();
        rows.hidden = bts.length < 2;
        for (const [id, bt] of bts) { bt.classList.toggle('on', id === t.get()); bt.setAttribute('aria-pressed', String(id === t.get())); }
      } });
  }

  // The tables for the room tab: the race (order or result), the last qualifying, the session's board.
  private timesHtml(r: RoomView): string {
    const { net, kit, log } = r, se = net.session, out: string[] = [];
    const race = (title: string) => net.standings.length && out.push(resultsTable(title, kit.raceRows(net.standings), 'race', net.selfId));
    const quali = () => log.qualifying?.length && out.push(resultsTable(log.qualifyingOneShot ? 'Qualifying (one shot)' : 'Qualifying', kit.boardRows(log.qualifying), 'board', net.selfId));
    const board = (title: string) => net.board.length && out.push(resultsTable(title, kit.boardRows(net.board), 'board', net.selfId));
    if (se.phase === 'race') { race(se.stage === 'results' ? 'Race results' : 'Race order'); quali(); }
    else if (se.phase === 'qualifying') board(se.oneShot ? 'Qualifying laps' : 'Qualifying times');
    else if (se.phase === 'practice') board('Practice times');
    else {
      if (net.standingsFinal) race('Last race');
      quali();
      board('Best laps in the lobby');
    }
    return out.join('');
  }

  private copyInvite(link: HTMLInputElement) {
    const done = () => { this.copied = performance.now(); this.update(); setTimeout(() => this.refresh(), 2100); };
    const fallback = () => { link.focus(); link.select(); try { if (document.execCommand('copy')) done(); } catch { /* the link stays selected */ } };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(link.value).then(done, fallback);
    else fallback();
  }

  private buildActions() {
    const { host } = this;
    this.actionsEl.innerHTML = '';
    const add = (label: string, run: () => void, primary = false) => {
      const bt = button('mbtn' + (primary ? ' primary' : ''), label);
      bt.addEventListener('click', run);
      this.actionsEl.append(bt);
      this.items.push({ el: bt, run });
    };
    // the main action comes first for ↑ ↓; row-reverse puts it on the right
    // (in a race the session puts the car on the grid and keeps the laps: no restarting)
    const racing = host.net.room()?.net.session.phase === 'race';
    if (!host.started()) add('Drive', () => this.close(), true);
    else {
      add('Resume', () => this.close(), true);
      if (!racing) add('Restart lap', () => { host.restart(); this.close(); });
    }
  }

  private buildTabs() {
    this.tabsEl.innerHTML = '';
    const tabs = this.tabs();
    if (!tabs.some(([t]) => t === this.tab)) this.tab = 'online';   // (in a room there is no Time trial tab)
    const bts = tabs.map(([t, label]) => {
      const bt = button(t === this.tab ? 'on' : '', label);
      bt.setAttribute('role', 'tab'); bt.setAttribute('aria-selected', String(t === this.tab));
      bt.addEventListener('click', () => this.setTab(t));
      this.tabsEl.append(bt);
      return bt;
    });
    this.items.push({ el: this.tabsEl, target: () => bts[tabs.findIndex(([t]) => t === this.tab)], cycle: (dir) => this.switchTab(dir) });
  }

  private setTab(t: Tab) {
    if (t === this.tab) return;
    this.tab = t; this.capture = null; this.armed = null; this.contentEl.scrollTop = 0;
    this.focus = this.items.findIndex((it) => it.el === this.tabsEl);
    this.build();
  }
  private switchTab(dir: number) { const tabs = this.tabs(); this.setTab(tabs[wrapI(tabs.findIndex(([t]) => t === this.tab) + dir, tabs.length)][0]); }

  private heading(text: string, parent: HTMLElement = this.contentEl) {
    const el = h('h2', 'mh', text); parent.append(el); return el;
  }

  // Something that needs a second click within 3 s.
  private arm(kind: Armed) {
    this.armed = kind; clearTimeout(this.armTimer);
    this.armTimer = window.setTimeout(() => { this.armed = null; this.armedCircuit = ''; this.refresh(); }, 3000);
  }

  // A reset link (or, with cls, a button) that needs two clicks within 3 s.
  private resetLink(kind: Armed, label: string, run: () => void, parent: HTMLElement, visible: () => boolean = () => true, cls = 'link',
    armedLabel = 'Click again to confirm') {
    const bt = button(cls, label);
    const click = () => {
      if (this.armed !== kind) this.arm(kind);
      else { this.armed = null; run(); }
      this.update();
    };
    bt.addEventListener('click', click);
    parent.append(bt);
    this.items.push({ el: bt, run: click, update: () => {
      const armed = this.armed === kind;
      bt.textContent = armed ? armedLabel : label;
      bt.classList.toggle('armed', armed);
      bt.hidden = !visible() && !armed;
    } });
  }

  // ---------------- Time trial tab ----------------

  private buildRace() {
    const { host } = this, c = this.contentEl;
    this.heading('Car');
    this.carCards(c, () => null);
    const head = h('div', 'mh-row'); c.append(head);
    this.heading('Circuit', head);
    this.circuitCards(head, (info) => info.id === host.settings.track, (info, bt, best) => {
      if (info.id === host.settings.track) return;
      bt.classList.add('loading'); best.textContent = 'Loading…';
      host.setSetting('track', info.id);
    }, () => false);
    const foot = h('div', 'mfoot'); c.append(foot);
    foot.append(h('span', '', 'Choosing another circuit reloads the game.'));
    this.resetLink('best', 'Reset best times for this car here', () => host.resetBestTimes(), foot,
      () => host.bestLap(host.loadedTrack, host.settings.car) != null);
  }

  // A card for each car. locked(id): why that car cannot be chosen now (null: it can).
  // bestLabel: what the best lap shown is (in a room, the race-conditions best).
  private carCards(parent: HTMLElement, locked: (id: CarId) => string | null, bestLabel = 'Best here') {
    const { host } = this;
    const cars = h('div', 'cards cars' + (bestLabel === 'Best here' ? '' : ' inroom')); parent.append(cars);
    for (const spec of Object.values(CARS)) {
      const bt = button('card car-card');
      const name = h('b', 'cname', spec.name), blurb = h('span', 'cblurb', spec.blurb);
      const facts = h('span', 'cfacts', `${Math.round(spec.powerKw * 1.341).toLocaleString('en')} hp · ${Math.round(spec.mass).toLocaleString('en')} kg`);
      const best = h('span', 'cbest');
      bt.append(name, blurb, facts, best);
      const pick = () => { if (!locked(spec.id)) host.setSetting('car', spec.id); };
      bt.addEventListener('click', pick);
      cars.append(bt);
      this.items.push({ el: bt, run: pick, cycle: (dir) => this.step(dir), update: () => {
        const on = host.settings.car === spec.id, why = locked(spec.id);
        bt.classList.toggle('sel', on); bt.setAttribute('aria-pressed', String(on));
        bt.classList.toggle('locked', !on && !!why); bt.title = !on && why ? why : '';
        const t = host.bestLap(host.loadedTrack, spec.id);
        best.innerHTML = t != null ? `${bestLabel} <b class="num">${fmtTime(t)}</b>` : 'No lap here yet';
      } });
    }
  }

  // A card for each circuit (a search box in `head` once there are enough). sel: the chosen one; locked: dimmed and
  // not choosable. With `only`, just the cards it lets through.
  private circuitCards(head: HTMLElement, sel: (info: CircuitInfo) => boolean, pick: (info: CircuitInfo, bt: HTMLElement, best: HTMLElement) => void,
    locked: (info: CircuitInfo) => boolean, only?: (info: CircuitInfo) => boolean) {
    const { host } = this, c = this.contentEl;
    const circuits = allCircuits().filter((i) => !only || only(i));
    const grid = h('div', 'cards circuits');
    const cards: [CircuitInfo, HTMLElement][] = [];
    if (circuits.length >= SEARCH_FROM) {
      const search = h('input', 'search');
      search.type = 'search'; search.placeholder = `Search ${circuits.length} circuits`; search.value = this.query;
      search.setAttribute('aria-label', 'Search circuits');
      search.addEventListener('input', () => { this.query = search.value; filter(); });
      head.append(search);
      this.items.push({ el: search });
    }
    const note = h('p', 'mnote');
    c.append(grid, note);
    for (const info of circuits) {
      const bt = button('card circuit-card');
      bt.innerHTML = `<svg viewBox="0 0 100 100" aria-hidden="true"><path d="${info.outline}"/><circle cx="${info.start[0]}" cy="${info.start[1]}" r="4.5"/></svg>`;
      const text = h('span', 'ctext');
      const name = h('b', 'cname', info.name), place = h('span', 'cblurb', info.place), best = h('span', 'cbest');
      const length = `${info.lengthKm.toFixed(2)} km`;
      text.append(name, place, best); bt.append(text);
      const run = () => { if (!locked(info)) pick(info, bt, best); };
      bt.addEventListener('click', run);
      grid.append(bt); cards.push([info, bt]);
      this.items.push({ el: bt, run, cycle: (dir) => this.step(dir), update: () => {
        const on = sel(info);
        bt.classList.toggle('sel', on); bt.setAttribute('aria-pressed', String(on));
        bt.classList.toggle('locked', !on && locked(info));
        const t = host.bestLap(info.id, host.settings.car);
        if (!bt.classList.contains('loading')) best.innerHTML = length + (t != null ? ` · Best <b class="num">${fmtTime(t)}</b>` : '');
      } });
    }
    const filter = () => {
      const q = this.query.trim().toLowerCase();
      let shown = 0;
      for (const [info, bt] of cards) { bt.hidden = !!q && !info.search.includes(q); if (!bt.hidden) shown++; }
      note.textContent = shown ? '' : 'No circuit matches that search.';
    };
    filter();
  }

  // ← → on a card: the next visible item.
  private step(dir: number) {
    let k = this.focus;
    do { k = wrapI(k + dir, this.items.length); } while (!this.shown(this.items[k]) && k !== this.focus);
    this.focus = k; this.target(this.items[k]).focus();
  }

  // ---------------- Settings tab ----------------

  private buildSettings() {
    const c = this.contentEl;
    const chips = h('div', 'seg chips'); c.append(chips);
    const bts = SECTIONS.map(([s, label]) => {
      const bt = button(s === this.section ? 'on' : '', label);
      bt.addEventListener('click', () => this.setSection(s));
      chips.append(bt); return bt;
    });
    this.items.push({ el: chips, target: () => bts[SECTIONS.findIndex(([s]) => s === this.section)],
      cycle: (dir) => this.setSection(SECTIONS[wrapI(SECTIONS.findIndex(([s]) => s === this.section) + dir, SECTIONS.length)][0]) });
    const rows = h('div', 'menu-settings'); c.append(rows);
    for (const key of SETTING_KEYS) if (SETTING_DEFS[key].section === this.section) this.addRow(key, rows);
    const foot = h('div', 'mfoot'); c.append(foot);
    foot.append(h('span', '', 'Settings are saved in this browser.'));
    this.resetLink('settings', 'Reset all settings', () => this.host.resetSettings(), foot);
  }

  private setSection(s: SettingSection) {
    if (s === this.section) return;
    this.section = s; this.armed = null;
    this.focus = this.items.findIndex((it) => it.el.classList.contains('chips'));
    this.build();
  }

  private addRow<K extends SettingKey>(key: K, parent: HTMLElement) {
    const { host } = this, d = SETTING_DEFS[key];
    const row = h('div', 'mrow');
    const lab = h('div', 'mlabel'); lab.append(h('span', '', d.label));
    if (d.hint) lab.append(h('small', '', d.hint.replace(/\{(\w+)\}/g, (m, a: string) => {
      const keys = a in ACTIONS ? host.bindings()[a as Action].filter((c) => c != null).map((c) => keyLabel(c)) : [];
      return keys.length ? keys.join(' / ') : a in ACTIONS ? `(${ACTIONS[a as Action]}: no key)` : m;
    })));
    row.append(lab);
    const dim = () => (MOUSE_ROWS.includes(key) && host.settings.steering !== 'mouse')
      || (key === 'assist' && !hasAssist(CARS[host.settings.car]));   // this car has no assist
    let target: () => HTMLElement, sync: () => void;
    if (d.slider) {
      const wrap = h('div', 'slider'), input = h('input'), out = h('output', 'num');
      input.type = 'range'; input.min = '0'; input.max = String(d.options.length - 1); input.step = '1';
      input.setAttribute('aria-label', d.label);
      input.addEventListener('input', () => host.setSetting(key, d.options[+input.value][0]));
      wrap.append(input, out); row.append(wrap);
      target = () => input;
      sync = () => {
        const i = d.options.findIndex(([v]) => v === host.settings[key]);
        if (+input.value !== i) input.value = String(i);
        input.style.setProperty('--fill', (i / (d.options.length - 1)) * 100 + '%');
        out.textContent = optionText(key, host.settings[key]);
      };
    } else {
      const seg = h('div', 'seg');
      const bts = d.options.map(([v, text]) => {
        const bt = button('', text);
        bt.addEventListener('click', () => host.setSetting(key, v));
        seg.append(bt); return [v, bt] as const;
      });
      row.append(seg);
      target = () => bts.find(([v]) => v === host.settings[key])?.[1] ?? bts[0][1];
      sync = () => { for (const [v, bt] of bts) { bt.classList.toggle('on', v === host.settings[key]); bt.setAttribute('aria-pressed', String(v === host.settings[key])); } };
    }
    parent.append(row);
    this.items.push({ el: row, target, cycle: (dir) => host.cycleSetting(key, dir), run: d.slider ? () => {} : () => host.cycleSetting(key, 1),
      update: () => { sync(); row.classList.toggle('dim', dim()); } });
  }

  // ---------------- Controls tab ----------------

  private buildControls() {
    const { host } = this, c = this.contentEl, b = host.bindings();
    this.heading('Steering');
    const rows = h('div', 'menu-settings'); c.append(rows);
    for (const key of SETTING_KEYS) if (SETTING_DEFS[key].section === 'controls') this.addRow(key, rows);

    const kh = h('div', 'mh-row'); c.append(kh);
    this.heading('Keyboard', kh);
    kh.append(h('span', 'mnote', 'Click a key to change it · Backspace clears · Esc cancels'));
    const keys = h('div', 'menu-settings keys'); c.append(keys);
    for (const a of ACTION_KEYS) {
      const row = h('div', 'mrow');
      row.append(h('div', 'mlabel', ACTIONS[a]));
      const caps = h('div', 'keycaps');
      if (a === 'menu') caps.append(h('kbd', 'keycap fixed', keyLabel(MENU_KEY)));
      const slots = ([0, 1] as Slot[]).map((slot) => {
        const code = b[a][slot], capturing = this.capture?.action === a && this.capture.slot === slot;
        const bt = button('keycap' + (code ? '' : ' empty') + (capturing ? ' capturing' : ''), capturing ? 'Press a key…' : code ? keyLabel(code) : '+');
        bt.title = capturing ? 'Press the key for ' + ACTIONS[a] : code ? 'Change this key' : 'Add a key';
        bt.addEventListener('click', () => {
          this.capture = capturing ? null : { action: a, slot };
          this.focus = this.items.findIndex((it) => it.el === row);
          this.build();
        });
        caps.append(bt); return bt;
      });
      row.append(caps); keys.append(row);
      let side = this.capture?.action === a ? this.capture.slot : 0;
      this.items.push({ el: row, target: () => slots[side], cycle: (dir) => { side = clamp(side + dir, 0, 1) as Slot; slots[side].focus(); } });
    }
    const kfoot = h('div', 'mfoot'); c.append(kfoot);
    kfoot.append(h('span', '', ''));
    this.resetLink('keys', 'Reset keys to defaults', () => host.resetBindings(), kfoot);

    this.heading('Mouse steering');
    c.append(this.refList([
      ['Cursor left / right of centre', 'Steer'], ['Left button', 'Throttle'], ['Right button', 'Brake (auto: reverse)'],
      ['Scroll wheel', 'Shift up / down'],
    ]));
    this.heading('Gamepad');
    c.append(this.refList([
      ['Left stick', 'Steer'], ['RT / LT', 'Throttle / brake'], ['RB / LB', 'Shift up / down'], ['Y', 'Change camera'],
      ['Right stick click', 'Look behind (hold)'], ['X / Back', 'Restart lap (in a race: a recovery)'], ['D-pad up', 'Next pit stop tyres (race weekends)'],
      ['Start', 'Pause menu'], ['In menus', 'D-pad moves · A selects · B back · LB / RB tabs'],
    ]));
  }

  private refList(rows: [string, string][]) {
    const dl = h('dl', 'ref');
    for (const [k, v] of rows) dl.append(h('dt', '', k), h('dd', '', v));
    return dl;
  }

  // ---------------- Keys ----------------

  // The element ↑ ↓ focus for an item.
  private target(it: MenuItem): HTMLElement { return it.target?.() ?? it.el; }

  private onKey(e: KeyboardEvent) {
    if (!this.isOpen || this.body.hidden) return;
    if (this.capture) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.repeat) return;
      const { action, slot } = this.capture;
      this.capture = null;
      if (e.code === MENU_KEY) this.build();
      else this.host.rebind(action, slot, e.code === 'Backspace' || e.code === 'Delete' ? null : e.code);
      return;
    }
    if (this.handle(e.code, e.repeat)) e.preventDefault();
  }

  // Menu navigation for a key (or gamepad button). Returns whether it was used.
  private handle(code: string, repeat: boolean, pad = false): boolean {
    const it = this.items[this.focus];
    const active = document.activeElement, hasFocus = this.hasFocus();
    const typing = active instanceof HTMLInputElement && (active.type === 'search' || active.type === 'text');
    const nav = ({ ArrowUp: -1, ArrowDown: 1 } as Record<string, number>)[code];
    if (nav) {
      // the first press only shows where the focus is
      if (hasFocus) {
        let k = this.focus;
        do { k = wrapI(k + nav, this.items.length); } while (!this.shown(this.items[k]) && k !== this.focus);
        this.focus = k;
      }
      const t = this.target(this.items[this.focus]);
      t.focus(); t.scrollIntoView({ block: 'nearest' });
      return true;
    }
    if (typing) {
      if (code === 'Escape' && (active as HTMLInputElement).type === 'search' && (active as HTMLInputElement).value) return false;   // the search box clears itself
      if (code !== 'Escape') return false;
    }
    if ((code === 'ArrowLeft' || code === 'ArrowRight') && it?.cycle) {
      if (!hasFocus) this.target(it).focus();
      it.cycle(code === 'ArrowLeft' ? -1 : 1);
      return true;
    }
    if (code === 'Enter' || code === 'Space') {
      // A focused button that isn't a row's current choice (reached with Tab or ← →) is pressed as usual.
      if (hasFocus && active instanceof HTMLButtonElement && !active.classList.contains('on')) {
        if (pad) active.click();
        return pad;
      }
      if (repeat) return true;
      if (it?.run) it.run(); else if (it?.cycle) it.cycle(1);
      return true;
    }
    if (code === 'Escape' && this.host.started() && !repeat) { this.close(); return true; }
    return false;
  }
}

const esc = (t: string) => t.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const carLabel = (id: string) => (id in CARS ? CARS[id as CarId].name : id);

// A results table (lobby.ts rows): a race's (laps, time or gap, best, stops, penalty) or a board's (best, gap, laps).
function resultsTable(title: string, rows: ResultRow[], kind: 'race' | 'board', self: number): string {
  const head = kind === 'race'
    ? '<th class="p">Pos</th><th>Driver</th><th>Laps</th><th>Time</th><th class="w">Best</th><th class="w">Stops</th><th class="w">Pen.</th>'
    : '<th class="p">Pos</th><th>Driver</th><th>Best</th><th>Gap</th><th class="w">Laps</th>';
  const body = rows.map((r) => {
    // (on a phone the columns marked w are hidden: the best lap, stops and penalty go under the name instead)
    const mob = kind === 'race' ? [r.best !== fmtTime(null) ? `best ${r.best}` : '', r.pits !== '0' ? `${r.pits} ${r.pits === '1' ? 'stop' : 'stops'}` : '', r.penalty ? `pen. ${r.penalty}` : '']
      .filter(Boolean).map((t) => ` · ${esc(t)}`).join('') : '';
    const who = `<td class="d"><b>${esc(r.name)}</b><small>${esc(r.car)}${mob ? `<span class="mob">${mob}</span>` : ''}</small></td>`;
    const cls = (r.player && r.player === self ? 'self' : '') + (r.out ? ' out' : '');
    return `<tr class="${cls}"><td class="p">${r.pos}</td>${who}` + (kind === 'race'
      ? `<td>${r.laps}</td><td class="t">${r.time}</td><td class="w">${r.best}</td><td class="w">${r.pits}</td><td class="w">${r.penalty}</td>`
      : `<td class="t">${r.best}</td><td>${r.pos === '1' ? '' : r.time}</td><td class="w">${r.laps}</td>`) + '</tr>';
  }).join('');
  return `<h2 class="mh">${esc(title)}</h2><table class="rtable num"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
