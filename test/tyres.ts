// Shared by the tyre and weather tests: a short timed stretch of the autopilot's lap at Melbourne, from the game's
// flying start, in given conditions and on given tyres.
import type { CarId } from '../src/cars';
import type { CompoundId, Conditions } from '../src/conditions';
import { LcCar } from '../src/lc/lcCar';
import { session } from './harness';

export const STRETCH_M = 2000;   // the first 2 km of the lap at Melbourne, about a third of it

type Harness = Awaited<ReturnType<typeof session>>;

// Every wheel's tread worn this much (0..1), whichever engine.
export function setWear(h: Harness, wear: number) {
  if (h.car instanceof LcCar) for (const w of h.car.vehicle.wheels) w.wear = wear;
  else for (const w of (h.car as unknown as { wheels: { wear: number }[] }).wheels) w.wear = wear;
}

// Seconds from the line to STRETCH_M into the lap, and the resets on the way (NaN if it never got there).
export function stretch(h: Harness) {
  let resets = 0;
  h.session.onReset = () => { resets++; };
  const { timing, car, session: s } = h;
  h.drive(120, null, () => timing.lapStart != null && car.proj.s > STRETCH_M && car.proj.s < STRETCH_M + 100);
  return { time: timing.lapStart == null ? NaN : s.simTime - timing.lapStart, resets };
}

// A fresh session on `compound` (at the heat of a lap, as the time trial's start) in `conditions`, its car placed
// again so the start speed is the one for them, then `before` (wear set, say), then the stretch.
export async function timedStretch(carId: CarId, { compound, conditions = {}, before }: {
  compound?: CompoundId; conditions?: Partial<Conditions>; before?: (h: Harness) => void;
} = {}) {
  const h = await session(carId, { flying: true });
  h.session.setConditions(conditions);
  if (compound && compound !== h.car.compound.id) h.car.fitTyres(compound, 'lap');
  if (compound || Object.keys(conditions).length) h.session.restart();
  before?.(h);
  return { ...stretch(h), h };
}
