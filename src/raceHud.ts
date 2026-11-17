import { COMPOUND_COLOURS, type CompoundId } from './conditions';
import type { Multiplayer } from './multiplayer';
import { COMPOUND_LETTER, sessionName } from './weekend';

// ============================================================================
// The race weekend's HUD (weekend.ts has the state): the start lights over the top of the screen, a strip under them
// (the race: position, lap and the gaps to the cars ahead and behind; practice and qualifying: the session and its
// clock, our place on the board), and a pit panel over the dash (pit lane and limiter, the service under way, the
// tyres the next stop fits, stops made of those required, a recovery's hold). In a race #hud gets the class `race`,
// which hides what a race does not need (the delta to a best lap, the optimal lap, the list of laps). Written only
// when a text changes.
// ============================================================================
const COMPOUND_IDS: Record<number, CompoundId> = { 1: 'soft', 2: 'medium', 3: 'hard', 4: 'intermediate', 5: 'wet' };
export const compoundChip = (code: number) => {
  const id = COMPOUND_IDS[code];
  return id ? `<i class="cchip" style="--cc:${COMPOUND_COLOURS[id]}">${COMPOUND_LETTER[code]}</i>` : '';
};
const clock = (s: number) => { const t = Math.max(0, Math.ceil(s)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const gapText = (g: number | null) => (g == null ? '' : `${g.toFixed(1)}`);
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export class RaceHud {
  tyreKey = '';                       // the key that changes the next compound (from the bindings)
  private readonly top: HTMLElement;
  private readonly lights: HTMLElement;
  private readonly info: HTMLElement;
  private readonly pit: HTMLElement;
  private readonly lamps: HTMLElement[] = [];
  private outFor = 0;                 // s the lights stay shown (all out) after the start
  private wasLit = 0;
  private html = { info: '', pit: '' };

  constructor(private readonly hud: HTMLElement) {
    this.top = document.createElement('div'); this.top.id = 'raceTop';
    this.lights = document.createElement('div'); this.lights.id = 'raceLights'; this.lights.className = 'panel';
    for (let k = 0; k < 5; k++) { const l = document.createElement('i'); this.lamps.push(l); this.lights.append(l); }
    this.info = document.createElement('div'); this.info.id = 'raceInfo'; this.info.className = 'panel';
    this.top.append(this.lights, this.info);
    this.pit = document.createElement('div'); this.pit.id = 'racePit'; this.pit.className = 'panel';
    hud.append(this.top, this.pit);
  }

  update(mp: Multiplayer, now: number, dt: number) {
    const w = mp.weekend, net = mp.net, s = net.session, race = s.phase === 'race';
    this.hud.classList.toggle('race', race);
    // the lights: lit one a second, then all out (shown out for a moment)
    const lit = race ? net.lightsLit(now) : 0, stage = w.raceStage;
    if (this.wasLit === 5 && lit === 0 && stage === 'racing') this.outFor = 1.5;
    this.wasLit = lit;
    this.outFor = Math.max(0, this.outFor - dt);
    const showLights = race && !w.spectator && (stage === 'grid' || stage === 'lights' || this.outFor > 0);
    this.lights.hidden = !showLights;
    this.lamps.forEach((l, k) => l.classList.toggle('on', k < lit));
    this.lights.classList.toggle('out', this.outFor > 0);
    this.set('info', this.infoHtml(mp, now));
    this.set('pit', this.pitHtml(mp));
  }

  dispose() { this.top.remove(); this.pit.remove(); this.hud.classList.remove('race'); }

  // ------------------------------------------------------------------------
  private set(k: 'info' | 'pit', html: string) {
    if (html === this.html[k]) return;
    this.html[k] = html;
    const el = k === 'info' ? this.info : this.pit;
    el.innerHTML = html; el.hidden = !html;
  }

  private infoHtml(mp: Multiplayer, now: number): string {
    const w = mp.weekend, net = mp.net, s = net.session;
    if (s.phase === 'lobby') return '';
    const left = net.timeLeft(now);
    if (s.phase !== 'race') {
      const row = net.board.findIndex((b) => b.player === net.selfId);
      const st = s.oneShot && s.goAt != null && net.serverTime(now) < s.goAt ? `GO IN ${clock(s.goAt - net.serverTime(now))}`
        : s.stage === 'finishing' ? 'LAST LAP' : left != null ? clock(left) : '';
      return `<div class="rrow"><span class="rname">${sessionName(s).toUpperCase()}</span><b class="num">${st}</b>`
        + `${row >= 0 ? `<span class="rpos">P${row + 1}</span>` : ''}</div>`;
    }
    if (w.spectator) return `<div class="rrow"><span class="rname">RACE</span><span class="rpos">SPECTATING</span></div>`;
    const me = w.order.find((e) => e.self), total = net.settings.raceLaps, n = w.order.length;
    const stage = w.raceStage;
    if (stage === 'grid' || stage === 'lights') {
      const slot = net.gridSlot();
      return `<div class="rrow"><span class="rname">GRID</span><b>P${(slot ?? 0) + 1}</b><small>/${s.grid.length}</small>`
        + `<span class="rlap">${total} LAPS</span></div>`;
    }
    const lap = Math.min(total, w.raceLaps + 1);
    let h = `<div class="rrow"><b class="rbig">P${me?.pos ?? '–'}</b><small>/${n}</small>`
      + `<span class="rlap">${w.finished ? 'FINISHED' : `LAP <b>${lap}</b>/${total}`}</span></div>`;
    if (!w.finished && stage !== 'results') {
      const name = (id: number) => esc(net.players.get(id)?.name ?? '');
      const a = w.aheadId ? `<span class="gap ahead">▲ ${name(w.aheadId)} <b class="num">${w.gapAhead != null ? '+' + gapText(w.gapAhead) : ''}</b></span>` : '<span class="gap ahead">LEADING</span>';
      const b = w.behindId ? `<span class="gap behind">▼ ${name(w.behindId)} <b class="num">${w.gapBehind != null ? '−' + gapText(w.gapBehind) : ''}</b></span>` : '';
      h += `<div class="rrow gaps">${a}${b}</div>`;
    }
    return h;
  }

  private pitHtml(mp: Multiplayer): string {
    const w = mp.weekend, p = w.pit, car = mp.session.car, race = w.inRace && !w.spectator;
    const rows: string[] = [];
    if (w.recovering > 0) rows.push(`<div class="prow warn"><span>RECOVERY</span><b class="num">${Math.ceil(w.recovering)} s</b></div>`);
    if (p.service > 0) {
      const f = 1 - p.service / Math.max(0.01, p.serviceTotal);
      rows.push(`<div class="prow box"><span>SERVICE</span><b class="num">${p.service.toFixed(1)} s</b></div><div class="pbar"><i style="width:${(f * 100).toFixed(0)}%"></i></div>`);
    } else if (p.inLane) {
      rows.push(`<div class="prow lane${p.limiter ? ' lim' : ''}"><span>PIT LANE</span><b>${p.limiter ? `LIMITER ${Math.round(w.lane.limitMs * 3.6)}` : p.stopped ? 'GO' : 'BOX AHEAD'}</b></div>`);
    }
    const stops = w.mandatoryStops;
    const showTyre = car.compounds.length > 1 && (race || p.inLane || p.zone !== 'track');
    if (showTyre) {
      const c = car.compounds.find((k) => k.id === w.nextCompound) ?? car.compound;
      rows.push(`<div class="prow"><span>NEXT TYRES${this.tyreKey ? ` <kbd>${esc(this.tyreKey)}</kbd>` : ''}</span><b><i class="cchip" style="--cc:${c.colour}">${c.letter}</i> ${esc(c.name.replace(/^GT3 /, ''))}</b></div>`);
    }
    const made = w.order.find((e) => e.self)?.pits ?? p.stops;
    if (race && stops > 0) rows.push(`<div class="prow${made >= stops ? ' done' : ''}"><span>STOPS</span><b class="num">${made}/${stops}</b></div>`);
    return rows.join('');
  }
}
