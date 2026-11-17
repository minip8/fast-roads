import { CARS, type CarId } from './cars';
import type { Multiplayer, Notice } from './multiplayer';
import type { BoardEntry } from './net';
import { playerColor, type RemoteStatus } from './remoteCars';
import { fmtTime } from './util';

// ============================================================================
// The room's board in the HUD (under the timing panel): room code, players, each one's best lap in the car they
// drive now, and where they are (on track, in the menu, a ghost, gone quiet); then a short feed of notices (joins,
// leaves, best laps), each shown for FEED_SECS. Redrawn only when its text changes, at most BOARD_HZ times a second.
// ============================================================================
const FEED_SECS = 5, FEED_MAX = 4, BOARD_HZ = 4;
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const carName = (id: string) => (id in CARS ? CARS[id as CarId].name : id);

export class NetHud {
  private readonly board: HTMLElement;
  private readonly feed: HTMLElement;
  private html = '';
  private wait = 0;
  private items: { el: HTMLElement; left: number }[] = [];

  constructor(parent: HTMLElement) {
    this.board = document.createElement('div');
    this.board.id = 'board'; this.board.className = 'panel';
    this.feed = document.createElement('div');
    this.feed.id = 'netFeed';
    parent.append(this.board, this.feed);
  }

  notice(n: Notice) {
    const el = document.createElement('div');
    el.className = 'note ' + n.kind; el.textContent = n.text;
    this.feed.prepend(el);
    this.items.unshift({ el, left: FEED_SECS });
    while (this.items.length > FEED_MAX) this.items.pop()!.el.remove();
  }

  update(mp: Multiplayer, status: ReadonlyMap<number, RemoteStatus>, dt: number, selfPaused: boolean) {
    for (const it of this.items) if ((it.left -= dt) <= 0) it.el.remove();
    this.items = this.items.filter((it) => it.left > 0);
    if ((this.wait -= dt) > 0) return;
    this.wait = 1 / BOARD_HZ;
    const net = mp.net, best = new Map<string, BoardEntry>();
    for (const b of net.board) if (b.player) best.set(`${b.player}:${b.car}`, b);
    const rows = [...net.players.values()].map((p) => {
      const b = best.get(`${p.id}:${p.car}`), self = p.id === net.selfId, st = status.get(p.id);
      const where = self ? (selfPaused ? 'menu' : mp.noCollide ? 'ghost' : 'track')
        : !st || !st.shown || st.stale ? 'away' : st.paused ? 'menu' : st.ghost && !mp.noCollide ? 'ghost' : 'track';
      return { id: p.id, name: p.name, car: p.car, best: b?.best ?? null, self, where };
    }).sort((a, b) => (a.best ?? Infinity) - (b.best ?? Infinity) || a.id - b.id);
    const lead = rows[0]?.best ?? null;
    const WHERE: Record<string, string> = { track: 'On track', menu: 'Menu', ghost: 'Ghost', away: 'No signal' };
    const html = `<div class="bhead"><span>ROOM <b>${esc(net.room)}</b></span><span>${net.players.size}/${net.maxPlayers}${net.rtt > 0 ? ` · ${Math.round(net.rtt * 1000)} ms` : ''}</span></div>`
      + rows.map((r, k) => `<div class="brow${r.self ? ' self' : ''} ${r.where}" title="${esc(carName(r.car))} · ${WHERE[r.where]}">`
        + `<span class="bpos">${r.best != null ? k + 1 : '–'}</span><i style="--c:${r.self ? 'var(--accent)' : playerColor(r.id)}"></i>`
        + `<span class="bname">${esc(r.name)}${r.self ? ' <small>you</small>' : ''}${r.where !== 'track' ? ` <em>${WHERE[r.where]}</em>` : ''}</span>`
        + `<span class="bcar">${esc(carName(r.car))}</span>`
        + `<span class="btime num">${r.best == null ? '—' : k === 0 || lead == null ? fmtTime(r.best) : '+' + (r.best - lead).toFixed(3)}</span></div>`).join('');
    if (html !== this.html) { this.html = html; this.board.innerHTML = html; }
  }

  dispose() { this.board.remove(); this.feed.remove(); }
}
