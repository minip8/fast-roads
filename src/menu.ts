import { allCircuits, type CircuitInfo } from './catalog';
import { CARS, hasAssist, type CarId } from './cars';
import { $ } from './dom';
import { ACTION_KEYS, ACTIONS, keyLabel, MENU_KEY, type Action, type Bindings, type Slot } from './keys';
import { SECTIONS, SETTING_DEFS, SETTING_KEYS, optionText, type SettingKey, type SettingSection, type Settings } from './settings';
import { TRACKS, type TrackId } from './tracks';
import { clamp, fmtTime, wrapI } from './util';

// ============================================================================
// Main / pause menu. A header with the main action (Drive, or Resume and Restart lap), then three tabs: Race (car and
// circuit cards), Settings (one section at a time) and Controls (steering devices, key bindings, mouse and gamepad).
// Mouse, keyboard (↑ ↓ move, ← → change, Enter select, Esc back) or gamepad (d-pad, A, B, LB / RB tabs).
// It talks to the game only through MenuHost.
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
}

type Tab = 'race' | 'settings' | 'controls';
const TABS: [Tab, string][] = [['race', 'Race'], ['settings', 'Settings'], ['controls', 'Controls']];
type Armed = 'best' | 'settings' | 'keys';

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

  open() {
    if (this.isOpen) return;
    this.isOpen = true; this.focus = 0; this.armed = null; this.capture = null;
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
    this.items = [];
    this.buildActions();
    this.buildTabs();
    this.contentEl.innerHTML = '';
    this.contentEl.dataset.tab = this.tab;
    if (this.tab === 'race') this.buildRace();
    else if (this.tab === 'settings') this.buildSettings();
    else this.buildControls();
    this.update();
    this.focus = clamp(this.focus, 0, this.items.length - 1);
    if (hadFocus) {
      while (this.focus > 0 && this.items[this.focus].el.hidden) this.focus--;
      this.target(this.items[this.focus]).focus({ preventScroll: true });
    }
  }

  private update() {
    const { host } = this, car = CARS[host.settings.car], track = TRACKS[host.loadedTrack];
    $('menuPaused').hidden = !host.started();
    $('menuSub').textContent = `Time trial · ${car.name} at ${track.name}`;
    for (const it of this.items) it.update?.();
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
    if (!host.started()) add('Drive', () => this.close(), true);
    else {
      add('Resume', () => this.close(), true);
      add('Restart lap', () => { host.restart(); this.close(); });
    }
  }

  private buildTabs() {
    this.tabsEl.innerHTML = '';
    const bts = TABS.map(([t, label]) => {
      const bt = button(t === this.tab ? 'on' : '', label);
      bt.setAttribute('role', 'tab'); bt.setAttribute('aria-selected', String(t === this.tab));
      bt.addEventListener('click', () => this.setTab(t));
      this.tabsEl.append(bt);
      return bt;
    });
    this.items.push({ el: this.tabsEl, target: () => bts[TABS.findIndex(([t]) => t === this.tab)], cycle: (dir) => this.switchTab(dir) });
  }

  private setTab(t: Tab) {
    if (t === this.tab) return;
    this.tab = t; this.capture = null; this.armed = null; this.contentEl.scrollTop = 0;
    this.focus = this.items.findIndex((it) => it.el === this.tabsEl);
    this.build();
  }
  private switchTab(dir: number) { this.setTab(TABS[wrapI(TABS.findIndex(([t]) => t === this.tab) + dir, TABS.length)][0]); }

  private heading(text: string, parent: HTMLElement = this.contentEl) {
    const el = h('h2', 'mh', text); parent.append(el); return el;
  }

  // A reset link that needs two clicks within 3 s.
  private resetLink(kind: Armed, label: string, run: () => void, parent: HTMLElement, visible: () => boolean = () => true) {
    const bt = button('link', label);
    const click = () => {
      if (this.armed !== kind) {
        this.armed = kind; clearTimeout(this.armTimer);
        this.armTimer = window.setTimeout(() => { this.armed = null; this.refresh(); }, 3000);
      } else { this.armed = null; run(); }
      this.update();
    };
    bt.addEventListener('click', click);
    parent.append(bt);
    this.items.push({ el: bt, run: click, update: () => {
      const armed = this.armed === kind;
      bt.textContent = armed ? 'Click again to confirm' : label;
      bt.classList.toggle('armed', armed);
      bt.hidden = !visible() && !armed;
    } });
  }

  // ---------------- Race tab ----------------

  private buildRace() {
    const { host } = this, c = this.contentEl;
    this.heading('Car');
    const cars = h('div', 'cards cars'); c.append(cars);
    for (const spec of Object.values(CARS)) {
      const bt = button('card car-card');
      const name = h('b', 'cname', spec.name), blurb = h('span', 'cblurb', spec.blurb);
      const facts = h('span', 'cfacts', `${Math.round(spec.powerKw * 1.341).toLocaleString('en')} hp · ${Math.round(spec.mass).toLocaleString('en')} kg`);
      const best = h('span', 'cbest');
      bt.append(name, blurb, facts, best);
      bt.addEventListener('click', () => host.setSetting('car', spec.id));
      cars.append(bt);
      this.items.push({ el: bt, run: () => host.setSetting('car', spec.id), cycle: (dir) => this.step(dir), update: () => {
        const on = host.settings.car === spec.id;
        bt.classList.toggle('sel', on); bt.setAttribute('aria-pressed', String(on));
        const t = host.bestLap(host.loadedTrack, spec.id);
        best.innerHTML = t != null ? `Best here <b class="num">${fmtTime(t)}</b>` : 'No lap here yet';
      } });
    }

    const head = h('div', 'mh-row'); c.append(head);
    this.heading('Circuit', head);
    const circuits = allCircuits();
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
      const pick = () => {
        if (info.id === host.settings.track) return;
        bt.classList.add('loading'); best.textContent = 'Loading…';
        host.setSetting('track', info.id);
      };
      bt.addEventListener('click', pick);
      grid.append(bt); cards.push([info, bt]);
      this.items.push({ el: bt, run: pick, cycle: (dir) => this.step(dir), update: () => {
        const on = host.settings.track === info.id;
        bt.classList.toggle('sel', on); bt.setAttribute('aria-pressed', String(on));
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
    const foot = h('div', 'mfoot'); c.append(foot);
    foot.append(h('span', '', 'Choosing another circuit reloads the game.'));
    this.resetLink('best', 'Reset best times for this car here', () => host.resetBestTimes(), foot,
      () => host.bestLap(host.loadedTrack, host.settings.car) != null);
  }

  // ← → on a card: the next visible item.
  private step(dir: number) {
    let k = this.focus;
    do { k = wrapI(k + dir, this.items.length); } while (this.items[k].el.hidden && k !== this.focus);
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
      ['Cursor left / right of centre', 'Steer'], ['Left button', 'Throttle'], ['Right button', 'Brake / reverse'],
      ['Scroll wheel', 'Shift up / down'],
    ]));
    this.heading('Gamepad');
    c.append(this.refList([
      ['Left stick', 'Steer'], ['RT / LT', 'Throttle / brake'], ['RB / LB', 'Shift up / down'], ['Y', 'Change camera'],
      ['X / Back', 'Restart lap'], ['Start', 'Pause menu'], ['In menus', 'D-pad moves · A selects · B back · LB / RB tabs'],
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
    const typing = active instanceof HTMLInputElement && active.type === 'search';
    const nav = ({ ArrowUp: -1, ArrowDown: 1 } as Record<string, number>)[code];
    if (nav) {
      // the first press only shows where the focus is
      if (hasFocus) {
        let k = this.focus;
        do { k = wrapI(k + nav, this.items.length); } while (this.items[k].el.hidden && k !== this.focus);
        this.focus = k;
      }
      const t = this.target(this.items[this.focus]);
      t.focus(); t.scrollIntoView({ block: 'nearest' });
      return true;
    }
    if (typing) {
      if (code === 'Escape' && (active as HTMLInputElement).value) return false;   // the search box clears itself
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
