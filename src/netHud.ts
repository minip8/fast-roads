import { CARS, type CarId } from './cars';
import type { Multiplayer, Notice } from './multiplayer';
import type { BoardEntry } from './net';
import { playerColor, type RemoteStatus } from './remoteCars';
import { compoundChip } from './raceHud';
import { fmtTime } from './util';
import { sessionName } from './weekend';

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
    if (mp.weekend.inRace) { this.write(this.tower(mp)); return; }
    const net = mp.net, best = new Map<string, BoardEntry>();
    for (const b of net.board) if (b.player) best.set(`${b.player}:${b.car}`, b);
    const rows = [...net.players.values()].map((p) => {
      const b = best.get(`${p.id}:${p.car}`), self = p.id === net.selfId, st = status.get(p.id);
      const where = self ? (selfPaused ? 'menu' : mp.noCollide ? 'ghost' : 'track')
        : !st || !st.shown || st.stale ? 'away' : st.paused ? 'menu' : st.ghost && !mp.noCollide ? 'ghost' : 'track';
      const code = self ? -1 : mp.players.get(p.id)?.sample.compound ?? 0;
      return { id: p.id, name: p.name, car: p.car, best: b?.best ?? null, self, where, cmp: code > 0 ? compoundChip(code) : '' };
    }).sort((a, b) => (a.best ?? Infinity) - (b.best ?? Infinity) || a.id - b.id);
    const lead = rows[0]?.best ?? null;
    const WHERE: Record<string, string> = { track: 'On track', menu: 'Menu', ghost: 'Ghost', away: 'No signal' };
    const se = net.session, phase = se.phase === 'lobby' ? `ROOM <b>${esc(net.room)}</b>`
      : `${(se.phase === 'qualifying' && se.oneShot ? 'One-shot quali' : sessionName(se)).toUpperCase()} · <b>${esc(net.room)}</b>`;
    const html = `<div class="bhead"><span>${phase}</span><span>${net.players.size}/${net.maxPlayers}${net.rtt > 0 ? ` · ${Math.round(net.rtt * 1000)} ms` : ''}</span></div>`
      + rows.map((r, k) => `<div class="brow${r.self ? ' self' : ''} ${r.where}" title="${esc(carName(r.car))} · ${WHERE[r.where]}">`
        + `<span class="bpos">${r.best != null ? k + 1 : '–'}</span><i style="--c:${r.self ? 'var(--accent)' : playerColor(r.id)}"></i>`
        + `<span class="bname">${esc(r.name)}${r.self ? ' <small>you</small>' : ''}${r.where !== 'track' ? ` <em>${WHERE[r.where]}</em>` : ''}</span>`
        + `<span class="bcar">${r.cmp}${esc(carName(r.car))}</span>`
        + `<span class="btime num">${r.best == null ? '—' : k === 0 || lead == null ? fmtTime(r.best) : '+' + (r.best - lead).toFixed(3)}</span></div>`).join('');
    this.write(html);
  }

  private write(html: string) { if (html !== this.html) { this.html = html; this.board.innerHTML = html; } }

  // In a race: the live timing tower (weekend.ts's running order): position, name, gap to the leader (or laps down,
  // or the finish), the tyres on, PIT while in the pit lane.
  private tower(mp: Multiplayer): string {
    const w = mp.weekend, net = mp.net, total = net.settings.raceLaps;
    const lead = w.order[0], lap = lead ? Math.min(total, lead.laps + (lead.status === 'racing' ? 1 : 0)) : 0;
    const head = `<div class="bhead"><span>RACE · <b>LAP ${lap}/${total}</b></span><span>${net.standingsFinal ? 'RESULT' : w.raceStage === 'finishing' ? 'FLAG' : ''}</span></div>`;
    return head + w.order.map((e) => {
      const gap = e.pos === 1 ? (e.status === 'finished' ? 'WIN' : 'LEADER') : e.lapsDown > 0 ? `+${e.lapsDown} L` : e.gap != null ? `+${e.gap.toFixed(1)}` : '';
      const tags = `${e.inPits ? ' <em>PIT</em>' : ''}${e.status === 'finished' ? ' <em>FIN</em>' : e.status === 'outOfTime' ? ' <em>OUT</em>' : ''}${e.penalty ? ` <em>+${e.penalty}s</em>` : ''}`;
      return `<div class="brow${e.self ? ' self' : ''}${e.inPits ? ' ghost' : ''}"><span class="bpos">${e.pos}</span><i style="--c:${e.self ? 'var(--accent)' : playerColor(e.id)}"></i>`
        + `<span class="bname">${esc(e.name)}${tags}</span><span class="bcar">${compoundChip(e.compound)}</span><span class="btime num">${gap}</span></div>`;
    }).join('');
  }

  dispose() { this.board.remove(); this.feed.remove(); }
}
