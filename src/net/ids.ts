// ============================================================================
// The car and circuit ids the relay accepts by default. Plain lists with no imports at all, so the relay (also the
// Cloudflare one, type-checked without the game's DOM types) pulls in none of the game's car or circuit data or
// types; idsCheck.ts has the compiler check each list holds only real ids and every one of them, and
// test/net-protocol.test.ts checks them against CARS / TRACKS.
// ============================================================================
export const NET_CARS = ['lcf1', 'lcgt3', 'drift'] as const;
export const NET_CIRCUITS = [
  'melbourne', 'shanghai', 'suzuka', 'miami', 'montreal', 'monaco', 'barcelona', 'spielberg', 'silverstone',
  'spa', 'hungaroring', 'zandvoort', 'monza', 'madrid', 'baku', 'singapore', 'austin', 'mexico', 'saopaulo',
  'lasvegas', 'lusail', 'yasmarina', 'bahrain', 'jeddah',
] as const;
export const DEFAULT_CIRCUIT: (typeof NET_CIRCUITS)[number] = 'melbourne';
