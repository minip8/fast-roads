import type { CarId } from '../cars';
import type { TrackId } from '../tracks';

// ============================================================================
// The car and circuit ids the relay accepts by default. Kept here as plain lists (type-only imports, so neither the
// relay nor this module pulls in the game's car or circuit data); the compiler checks each list holds only real
// ids and test/net-protocol.test.ts that it holds all of them.
// ============================================================================
export const NET_CARS = ['lcf1', 'lcgt3', 'drift'] as const satisfies readonly CarId[];
export const NET_CIRCUITS = [
  'melbourne', 'shanghai', 'suzuka', 'miami', 'montreal', 'monaco', 'barcelona', 'spielberg', 'silverstone',
  'spa', 'hungaroring', 'zandvoort', 'monza', 'madrid', 'baku', 'singapore', 'austin', 'mexico', 'saopaulo',
  'lasvegas', 'lusail', 'yasmarina', 'bahrain', 'jeddah',
] as const satisfies readonly TrackId[];
export const DEFAULT_CIRCUIT: TrackId = 'melbourne';

// Compile-time: every CarId / TrackId is listed (a new car or circuit that is missing fails `npm run typecheck`).
type Missing<All, Listed> = Exclude<All, Listed> extends never ? true : Exclude<All, Listed>;
export const allCarsListed: Missing<CarId, (typeof NET_CARS)[number]> = true;
export const allCircuitsListed: Missing<TrackId, (typeof NET_CIRCUITS)[number]> = true;
