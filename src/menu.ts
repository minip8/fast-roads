import { $ } from './dom';
import { SETTING_DEFS, SETTING_KEYS, type SettingKey, type Settings } from './settings';
import { clamp, fmtTime, wrapI } from './util';

// ============================================================================
// Main / pause menu: actions, one row per setting, best lap and reset. Mouse or keyboard (↑ ↓ ← → Enter).
// ============================================================================
export interface MenuHost {
  readonly settings: Readonly<Settings>;
  started(): boolean;                   // false before the first Drive: shows Drive instead of Resume / Restart
  bestLap(): number | null;             // current car's best
  setSetting<K extends SettingKey>(key: K, value: Settings[K]): void;
  cycleSetting(key: SettingKey, dir?: number): void;
  restart(): void;
  resetBestTimes(): void;
  onOpen(): void;
  onClose(): void;
}

interface MenuItem { el: HTMLElement; run?: () => void; setting?: SettingKey }

export class Menu {
  isOpen = true;                        // the page opens on the menu
  keyboardUsed = false;                 // only show the focus outline once the keyboard has been used
  private readonly overlay = $('overlay');
  private readonly actionsEl = $('menuActions');
  private readonly settingsEl = $('menuSettings');
  private readonly resetEl = $('resetBest');
  private readonly body = $('menuBody');
  private items: MenuItem[] = [];
  private focus = 0;
  private resetArmed = false;

  constructor(private readonly host: MenuHost) {
    this.resetEl.addEventListener('click', () => this.onReset());
    addEventListener('keydown', (e) => this.onKey(e));
  }

  // Hide the loading text and show the menu itself.
  show() { $('loadState').hidden = true; this.body.hidden = false; this.render(); }
  refresh() { if (this.isOpen) this.render(); }

  open() {
    if (this.isOpen) return;
    this.isOpen = true; this.focus = 0; this.resetArmed = false;
    this.overlay.classList.remove('hidden');
    this.host.onOpen();
    this.render();
  }

  close() {
    this.isOpen = false; this.overlay.classList.add('hidden');
    this.host.onClose();
  }

  private actions(): [label: string, run: () => void, primary?: boolean][] {
    return !this.host.started()
      ? [['Drive', () => this.close(), true]]
      : [['Resume', () => this.close(), true],
         ['Restart session', () => { this.host.restart(); this.close(); }]];
  }

  private render() {
    const { host, resetEl } = this;
    this.items = [];
    this.actionsEl.innerHTML = '';
    for (const [label, run, primary] of this.actions()) {
      const bt = document.createElement('button');
      bt.type = 'button'; bt.className = 'mbtn' + (primary ? ' primary' : ''); bt.textContent = label;
      bt.addEventListener('click', run);
      this.actionsEl.append(bt);
      this.items.push({ el: bt, run });
    }
    this.settingsEl.innerHTML = '';
    const addRow = <K extends SettingKey>(key: K) => {
      const d = SETTING_DEFS[key];
      const row = document.createElement('div'); row.className = 'mrow';
      const lab = document.createElement('span'); lab.textContent = d.label;
      const seg = document.createElement('div'); seg.className = 'seg';
      for (const [v, text] of d.options) {
        const bt = document.createElement('button');
        bt.type = 'button'; bt.textContent = text; bt.className = host.settings[key] === v ? 'on' : '';
        bt.addEventListener('click', () => host.setSetting(key, v));
        seg.append(bt);
      }
      row.append(lab, seg); this.settingsEl.append(row);
      this.items.push({ el: row, setting: key });
    };
    SETTING_KEYS.forEach(addRow);
    this.items.push({ el: resetEl, run: () => this.onReset() });
    this.focus = clamp(this.focus, 0, this.items.length - 1);
    this.items.forEach((it, k) => it.el.classList.toggle('focus', k === this.focus && this.keyboardUsed));
    const best = host.bestLap();
    $('menuBest').innerHTML = best != null ? `Best lap <b>${fmtTime(best)}</b>` : 'No best lap yet';
    resetEl.textContent = this.resetArmed ? 'Click again to reset' : 'Reset best times';
    resetEl.classList.toggle('armed', this.resetArmed);
    resetEl.hidden = best == null && !this.resetArmed;
  }

  // Reset best times needs two clicks within 3 s.
  private onReset() {
    if (!this.resetArmed) {
      this.resetArmed = true; this.render();
      setTimeout(() => { this.resetArmed = false; if (this.isOpen) this.render(); }, 3000);
      return;
    }
    this.resetArmed = false; this.host.resetBestTimes(); this.render();
  }

  private onKey(e: KeyboardEvent) {
    if (!this.isOpen || this.body.hidden) return;
    const it = this.items[this.focus];
    const nav = ({ ArrowUp: -1, ArrowDown: 1 } as Record<string, number>)[e.code];
    if (nav) {
      this.keyboardUsed = true;
      do { this.focus = wrapI(this.focus + nav, this.items.length); } while (this.items[this.focus].el.hidden);
      this.render(); e.preventDefault(); return;
    }
    if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && it?.setting) {
      this.keyboardUsed = true; this.host.cycleSetting(it.setting, e.code === 'ArrowLeft' ? -1 : 1); e.preventDefault(); return;
    }
    if (e.code === 'Enter' || e.code === 'Space') {
      e.preventDefault();
      if (it?.setting) this.host.cycleSetting(it.setting, 1); else if (it?.run) it.run();
      return;
    }
    if (e.code === 'Escape' && this.host.started() && !e.repeat) this.close();
  }
}
