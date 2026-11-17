import type { CarId } from '../cars';
import type { TrackId } from '../tracks';
import { NET_CARS, NET_CIRCUITS } from './ids';

// ============================================================================
// Compile-time only (nothing imports this; `npm run typecheck` checks it): ids.ts lists only real car and circuit
// ids, and every one of them (a new car or circuit missing from the lists fails the typecheck).
// ============================================================================
export const onlyRealCars: readonly CarId[] = NET_CARS;
export const onlyRealCircuits: readonly TrackId[] = NET_CIRCUITS;
type Missing<All, Listed> = Exclude<All, Listed> extends never ? true : Exclude<All, Listed>;
export const allCarsListed: Missing<CarId, (typeof NET_CARS)[number]> = true;
export const allCircuitsListed: Missing<TrackId, (typeof NET_CIRCUITS)[number]> = true;
