import { COMPOUND_COLOURS, type CompoundId } from './conditions';
import type { Multiplayer } from './multiplayer';
import { COMPOUND_LETTER, sessionName } from './weekend';

// ============================================================================
// The race weekend's HUD (weekend.ts has the state): the start lights over the top of the screen, a strip under them
// (the race: position, lap and the gaps to the cars ahead and behind; practice and qualifying: the session and its
// clock, our place on the board), and a pit panel over the dash (pit lane and limiter, the service under way, the
// tyres the next stop fits, stops made of those required, a recovery's hold), and the pit guidance (#pitGuide, under
// the race strip: the pit request's steps from the entry to the box and out, a suggested stop, the one-line explanation of
// pit stops the first time). In a race #hud gets the class `race`,
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
  pitKey = '';                        // the pit request's key
  private readonly top: HTMLElement;
  private readonly lights: HTMLElement;
  private readonly info: HTMLElement;
  private readonly pit: HTMLElement;
  private readonly lamps: HTMLElement[] = [];
  private outFor = 0;                 // s the lights stay shown (all out) after the start
  private wasLit = 0;
  private readonly guide: HTMLElement;
  private html = { info: '', pit: '', guide: '' };

  constructor(private readonly hud: HTMLElement) {
    this.top = document.createElement('div'); this.top.id = 'raceTop';
    this.lights = document.createElement('div'); this.lights.id = 'raceLights'; this.lights.className = 'panel';
    for (let k = 0; k < 5; k++) { const l = document.createElement('i'); this.lamps.push(l); this.lights.append(l); }
    this.info = document.createElement('div'); this.info.id = 'raceInfo'; this.info.className = 'panel';
    this.top.append(this.lights, this.info);
    this.pit = document.createElement('div'); this.pit.id = 'racePit'; this.pit.className = 'panel';
    this.guide = document.createElement('div'); this.guide.id = 'pitGuide';
    this.top.append(this.guide);
    this.info.hidden = this.pit.hidden = this.guide.hidden = true;   // (until they have something to show: the lobby has none)
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
    this.set('guide', this.guideHtml(mp));
  }

  dispose() { this.top.remove(); this.pit.remove(); this.hud.classList.remove('race'); }

  // ------------------------------------------------------------------------
  private set(k: 'info' | 'pit' | 'guide', html: string) {
    if (html === this.html[k]) return;
    this.html[k] = html;
    const el = k === 'info' ? this.info : k === 'pit' ? this.pit : this.guide;
    el.innerHTML = html; el.hidden = !html;
  }

  private infoHtml(mp: Multiplayer, now: number): string {
    const w = mp.weekend, net = mp.net, s = net.session;
    if (s.phase === 'lobby') return '';
    const left = net.timeLeft(now);
    if (s.phase !== 'race') {
      const row = net.board.findIndex((b) => b.player === net.selfId);
      const runners = w.oneShotRunners(now);
      if (runners.length) return this.oneShotHtml(mp, now, runners, row);
      const st = s.stage === 'finishing' ? 'LAST LAP' : left != null ? clock(left) : '';
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

  // One-shot qualifying: our turn (out in m:ss, out now, done and our place) and who is on track and next out.
  private oneShotHtml(mp: Multiplayer, now: number, runners: ReturnType<Multiplayer['weekend']['oneShotRunners']>, row: number): string {
    const w = mp.weekend, net = mp.net, name = (id: number) => (id === net.selfId ? 'You' : esc(net.players.get(id)?.name ?? '?'));
    const me = runners.find((r) => r.id === net.selfId), wait = w.oneShotIn(now);
    const st = !me ? 'NOT TIMED' : me.state === 'done' ? (row >= 0 ? `DONE <span class="rpos">P${row + 1}</span>` : 'DONE')
      : me.state === 'out' ? 'YOUR LAP' : wait != null && wait > 0 ? `OUT IN <b class="num">${clock(wait)}</b>` : 'OUT NEXT';
    const k = runners.findIndex((r) => r.id === net.selfId);
    const out = runners.filter((r) => r.state === 'out').map((r) => name(r.id));
    const next = runners.find((r) => r.state === 'waiting');
    const tail = [out.length ? `ON TRACK <b>${out.join(', ')}</b>` : 'TRACK CLEAR',
      next && next.id !== net.selfId ? `NEXT <b>${name(next.id)}</b>` : ''].filter(Boolean).join(' · ');
    return `<div class="rrow"><span class="rname">ONE-SHOT${k >= 0 ? ` · ${k + 1}/${runners.length}` : ''}</span><span class="rlap">${st}</span></div>`
      + `<div class="rrow gaps"><span class="gap">${tail}</span></div>`;
  }

  private pitHtml(mp: Multiplayer): string {
    const w = mp.weekend, p = w.pit, car = mp.session.car, race = w.inRace && !w.spectator && !w.finished;
    const rows: string[] = [];
    if (w.recovering > 0) rows.push(`<div class="prow warn"><span>RECOVERY</span><b class="num">${Math.ceil(w.recovering)} s</b></div>`);
    // (the lane, the limiter and the service are the guidance's, below)
    const stops = w.mandatoryStops;
    const showTyre = car.compounds.length > 1 && (race || p.inLane || p.zone !== 'track' || w.pitRequest);
    if (w.pitRequest && !p.inLane && p.service === 0) rows.push(`<div class="prow lane"><span>PIT${this.pitKey ? ` <kbd>${esc(this.pitKey)}</kbd>` : ''}</span><b>BOX THIS LAP</b></div>`);
    if (showTyre) {
      const c = car.compounds.find((k) => k.id === w.nextCompound) ?? car.compound;
      rows.push(`<div class="prow"><span>NEXT TYRES${this.tyreKey ? ` <kbd>${esc(this.tyreKey)}</kbd>` : ''}</span><b><i class="cchip" style="--cc:${c.colour}">${c.letter}</i> ${esc(c.name.replace(/^GT3 /, ''))}</b></div>`);
    }
    const made = w.order.find((e) => e.self)?.pits ?? p.stops;
    if (race && stops > 0) rows.push(`<div class="prow${made >= stops ? ' done' : ''}"><span>PIT STOPS${made < stops ? ' OWED' : ''}</span><b class="num">${made}/${stops}</b></div>`);
    return rows.join('');
  }

  // The pit guidance: one line (and a bar while serviced), what to do next; else a suggested stop; and the one-line
  // explanation of pit stops for its first seconds.
  private guideHtml(mp: Multiplayer): string {
    const w = mp.weekend, g = w.pitGuide, key = this.pitKey ? `<kbd>${esc(this.pitKey)}</kbd>` : '';
    const side = (sd: 1 | -1) => (sd > 0 ? '<i class="garrow">◀</i> LEFT' : 'RIGHT <i class="garrow">▶</i>');
    const m = (d: number) => (d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.max(0, Math.round(d / 10) * 10)} m`);
    let line = '', cls = '';
    if (g) {
      switch (g.step) {
        case 'entry':
          cls = g.dist < 400 ? 'now' : '';
          line = g.dist < 1500 ? `<b>PIT ENTRY ${g.dist < 15 ? 'NOW' : m(g.dist)}</b><span>${side(g.side)}</span>` : `<b>BOX THIS LAP</b><span>PIT ENTRY IN ${m(g.dist)}</span>`;
          if (key) line += `<small>${key} cancel</small>`;
          break;
        case 'lane': cls = 'lane'; line = `<b>${g.limiter ? 'LIMITER ON' : 'PIT LANE'} · ${Math.round(w.lane.limitMs * 3.6)} KM/H</b><span>BOX ${m(g.box)}</span>`; break;
        case 'box': cls = 'box'; line = `<b>STOP IN THE BOX</b><span>${g.box > 0.5 ? m(g.box) : 'HERE'}</span><small>the limiter brings you to a stop</small>`; break;
        case 'service': {
          cls = 'box';
          const f = 1 - g.left / Math.max(0.01, g.total);
          line = `<b>TYRES ON</b><span class="num">${g.left.toFixed(1)} s</span><div class="pbar"><i style="width:${(f * 100).toFixed(0)}%"></i></div>`;
          break;
        }
        case 'go': cls = 'go'; line = '<b>GO</b><span>PIT EXIT <i class="garrow">▶</i></span>'; break;
        case 'through': cls = 'lane'; line = `<b>PIT LANE · ${Math.round(w.lane.limitMs * 3.6)} KM/H</b><span>DRIVE-THROUGH</span>${key ? `<small>${key} stop in the box</small>` : ''}`; break;
      }
    } else {
      const a = w.pitAdvice;
      if (a) { cls = 'advice'; line = `<b>BOX THIS LAP?</b><span>${esc(a)}</span>${key ? `<small>${key} pit</small>` : ''}`; }
    }
    const help = w.pitHelpFor > 0 && w.pitHelp ? `<div class="ghelp">${esc(w.pitHelp.replace('the pit key', this.pitKey ? this.pitKey : 'the pit key'))}</div>` : '';
    return line || help ? `${line ? `<div class="gline ${cls}">${line}</div>` : ''}${help}` : '';
  }
}
