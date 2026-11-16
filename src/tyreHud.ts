import type { Vehicle } from './vehicle';

// ============================================================================
// The HUD's tyre widget: the four tyres as on the car (fronts on top), each coloured by its carcass temperature
// against its compound's working window, with that temperature, the hot pressure and the brake disc's temperature.
// Only cars whose physics models tyre heat (Vehicle.tyres) have it; for the others it hides. Degrees C whatever the
// speed unit (mph is no sign of Fahrenheit), pressures in psi as the cars' data.
// ============================================================================
export type TyreBand = 'cold' | 'cool' | 'ok' | 'warm' | 'hot';
const NEAR = 10;   // deg C either side of the window shown as nearly there (cool) or a little over (warm)

// Where a temperature sits against a working window [lo, hi]: far below, just below, in it, just over, far over.
export function tyreBand(c: number, [lo, hi]: readonly [number, number]): TyreBand {
  return c < lo - NEAR ? 'cold' : c < lo ? 'cool' : c <= hi ? 'ok' : c <= hi + NEAR ? 'warm' : 'hot';
}

interface Cell { root: HTMLElement; temp: HTMLElement; psi: HTMLElement; brake: HTMLElement; wear: HTMLElement; band: string; t: string; p: string; b: string; w: string }

export class TyreWidget {
  private readonly cells: Cell[] = [];
  private enabled = true;
  private shown: boolean;

  constructor(private readonly root: HTMLElement) {
    root.innerHTML = '<div class="thead">TYRES <span>°C · psi · brake</span></div><div class="tgrid"></div>';
    const grid = root.querySelector('.tgrid')!;
    for (let k = 0; k < 4; k++) {
      const c = document.createElement('div');
      c.className = 'tyre'; c.innerHTML = '<b class="num"></b><span class="num"></span><span class="num brk"></span><span class="num wr" hidden></span>';
      grid.append(c);
      const [temp, psi, brake, wear] = c.children as unknown as HTMLElement[];
      this.cells.push({ root: c, temp, psi, brake, wear, band: '', t: '', p: '', b: '', w: '' });
    }
    this.shown = !root.hidden;
  }

  setEnabled(on: boolean) { this.enabled = on; }

  // Writes only what changed (the numbers move a few times a second at most).
  update(car: Vehicle) {
    const ty = car.tyres, show = this.enabled && ty !== undefined;
    if (show !== this.shown) { this.root.hidden = !show; this.shown = show; }
    if (!show) return;
    for (let k = 0; k < 4; k++) {
      const c = this.cells[k], s = ty.wheels[k], axle = k < 2 ? 0 : 1;
      const band = 'tyre ' + tyreBand(s.coreC, ty.windowC[axle]);
      if (band !== c.band) { c.band = band; c.root.className = band; }
      const t = String(Math.round(s.coreC)), p = s.pressurePsi.toFixed(1), b = 'B ' + Math.round(s.brakeC);
      const w = s.wear === undefined ? '' : Math.round((1 - s.wear) * 100) + '%';
      if (t !== c.t) { c.t = t; c.temp.textContent = t; }
      if (p !== c.p) { c.p = p; c.psi.textContent = p; }
      if (b !== c.b) { c.b = b; c.brake.textContent = b; }
      if (w !== c.w) { c.w = w; c.wear.textContent = w; c.wear.hidden = w === ''; }
    }
  }
}
