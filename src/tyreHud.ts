import type { Vehicle } from './vehicle';

// ============================================================================
// The HUD's tyre widget: the four tyres as on the car (fronts on top). Each tile is coloured by its carcass temperature
// against its compound's working window and shows that temperature large, with a strip across its top coloured by the
// tread surface's inner, middle and outer bands (outer edge outside, as on the car), the tread surface temperature,
// the hot pressure and the brake disc's temperature. The carcass moves slowly and is what the window is about; the
// tread reacts within seconds (it heats in a corner and cools on a straight). Only cars whose physics models tyre heat
// (Vehicle.tyres) have it; for the others it hides. Degrees C whatever the speed unit (mph is no sign of Fahrenheit),
// pressures in psi as the cars' data.
// While the tyres wear (Vehicle.wearing) or a compound other than the car's default is fitted, a badge between the
// tyres shows the compound (letter on its colour) and each tile the tread left. A car with wear but no tyre heat (the
// drift car) gets the tiles with the tread left alone, coloured by it.
// ============================================================================
export type TyreBand = 'cold' | 'cool' | 'ok' | 'warm' | 'hot';
const NEAR = 10;           // deg C either side of the window shown as nearly there (cool) or a little over (warm)
// The tread surface against the same window, with a wider margin: the grip is read at the carcass plus a quarter of
// the surface's difference from it, so 20 deg C of surface moves the grip as much as 5 of carcass, and the surface
// swings by that much within a lap.
const NEAR_SURFACE = 20;

// Where a temperature sits against a working window [lo, hi]: far below, just below, in it, just over, far over.
export function tyreBand(c: number, [lo, hi]: readonly [number, number], near = NEAR): TyreBand {
  return c < lo - near ? 'cold' : c < lo ? 'cool' : c <= hi ? 'ok' : c <= hi + near ? 'warm' : 'hot';
}
export const treadBand = (c: number, win: readonly [number, number]) => tyreBand(c, win, NEAR_SURFACE);
// The tread left (0..1) as a band: plenty, getting low (a quarter of the way to the cliff on the GT3's curve), nearly
// finished.
export const lifeBand = (life: number): TyreBand => (life > 0.5 ? 'ok' : life > 0.2 ? 'warm' : 'hot');

interface Cell {
  root: HTMLElement; seg: HTMLElement[]; temp: HTMLElement; tread: HTMLElement; psi: HTMLElement; brake: HTMLElement; wear: HTMLElement;
  band: string; segs: string[]; t: string; s: string; p: string; b: string; w: string;
}

export class TyreWidget {
  private readonly cells: Cell[] = [];
  private readonly badge: HTMLElement;
  private enabled = true;
  private shown: boolean;
  private mode = '';                        // '' heat, 'life' tread left only (no heat); class on the root
  private cmp = '';                         // the badge's compound id, '' hidden

  constructor(private readonly root: HTMLElement) {
    root.innerHTML = '<div class="thead">TYRES <span>°C · T tread · psi · B brake</span></div><div class="tgrid"></div>';
    const grid = root.querySelector('.tgrid')!;
    this.badge = document.createElement('i');
    this.badge.className = 'cmp';
    this.badge.hidden = true;
    grid.append(this.badge);
    for (let k = 0; k < 4; k++) {
      const c = document.createElement('div');
      c.className = 'tyre';
      c.innerHTML = '<i class="strip"><i></i><i></i><i></i></i><b class="num"></b><span class="num tr"></span><span class="num"></span>' +
        '<span class="num brk"></span><span class="num wr" hidden></span>';
      grid.append(c);
      const [strip, temp, tread, psi, brake, wear] = c.children as unknown as HTMLElement[];
      // left to right as seen from above: a left tyre's outer band is on the left, a right tyre's on the right
      const seg = [...strip.children] as HTMLElement[];
      if (k % 2 === 0) seg.reverse();   // seg[b]: band b (inner, middle, outer)
      this.cells.push({ root: c, seg, temp, tread, psi, brake, wear, band: '', segs: ['', '', ''], t: '', s: '', p: '', b: '', w: '' });
    }
    this.shown = !root.hidden;
  }

  setEnabled(on: boolean) { this.enabled = on; }

  // Writes only what changed (the numbers move a few times a second at most).
  update(car: Vehicle) {
    const ty = car.tyres, show = this.enabled && (ty !== undefined || car.wearing);
    if (show !== this.shown) { this.root.hidden = !show; this.shown = show; }
    if (!show) return;
    const cmp = car.wearing || car.compound !== car.compounds[0] ? car.compound.id : '';
    if (cmp !== this.cmp) {
      this.cmp = cmp; this.badge.hidden = cmp === '';
      this.badge.textContent = car.compound.letter; this.badge.title = car.compound.name; this.badge.style.background = car.compound.colour;
    }
    const mode = ty ? '' : 'life';
    if (mode !== this.mode) { this.mode = mode; this.root.classList.toggle('lifeOnly', mode === 'life'); }
    if (!ty) {
      for (let k = 0; k < 4; k++) {
        const c = this.cells[k], life = 1 - car.tyreWear[k], band = 'tyre ' + lifeBand(life), t = Math.round(life * 100) + '%';
        if (band !== c.band) { c.band = band; c.root.className = band; }
        if (t !== c.t) { c.t = t; c.temp.textContent = t; }
      }
      return;
    }
    for (let k = 0; k < 4; k++) {
      const c = this.cells[k], s = ty.wheels[k], win = ty.windowC[k < 2 ? 0 : 1];
      const band = 'tyre ' + tyreBand(s.coreC, win);
      if (band !== c.band) { c.band = band; c.root.className = band; }
      for (let b = 0; b < 3; b++) {
        const sb = treadBand(s.bandsC[b], win);
        if (sb !== c.segs[b]) { c.segs[b] = sb; c.seg[b].className = sb; }
      }
      const t = String(Math.round(s.coreC)), st = 'T ' + Math.round(s.surfaceC), p = s.pressurePsi.toFixed(1), b = 'B ' + Math.round(s.brakeC);
      const w = s.wear === undefined ? '' : Math.round((1 - s.wear) * 100) + '%';
      if (t !== c.t) { c.t = t; c.temp.textContent = t; }
      if (st !== c.s) { c.s = st; c.tread.textContent = st; }
      if (p !== c.p) { c.p = p; c.psi.textContent = p; }
      if (b !== c.b) { c.b = b; c.brake.textContent = b; }
      if (w !== c.w) { c.w = w; c.wear.textContent = w; c.wear.hidden = w === ''; }
    }
  }
}
