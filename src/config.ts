// ============================================================================
// Config
// ============================================================================
export const DT = 1 / 120;                 // fixed physics step
export const MAX_STEPS_PER_FRAME = 10;
export const KERB_W = 1.3;                 // kerb width beyond the track edge (m)
export const GRAVEL_W = 22;                // gravel trap depth beyond the kerb (m)
export const LIMIT_TOL_NO_KERB = 0.3;      // track-limit tolerance where there is no kerb (m)

// Surface properties: mu = peak grip, rr = rolling resistance coeff (x load),
// decel = ploughing resistance (m/s^2) when the whole car is on that surface.
export interface Surface { name: string; mu: number; rr: number; decel: number }
export const SURF: Surface[] = [
  { name: 'asphalt', mu: 1.65, rr: 0.012, decel: 0 },
  { name: 'kerb',    mu: 1.45, rr: 0.02,  decel: 0 },
  { name: 'grass',   mu: 1.05, rr: 0.02,  decel: 0.8 },
  { name: 'gravel',  mu: 0.80, rr: 0.04,  decel: 6 },
];
export const SURF_BLEND_T = 0.1;       // s: grip/resistance ease between surfaces so the car doesn't snap at the edge
export const PLOUGH_FADE_V = 25;       // m/s: ploughing resistance fades (quadratically) below this so you can drive out
export const PLOUGH_WHEEL_SHARE = 0.15; // share applied at the wheels (mild tug toward the side that's off); rest at the CoM
export const S_ASPHALT = 0, S_KERB = 1, S_GRASS = 2, S_GRAVEL = 3;

// Collision groups: (membership << 16) | filter
export const G_GROUND = 0x1, G_WALL = 0x2, G_CAR = 0x4, G_CARPART = 0x8, G_RAY = 0x10;
export const groups = (member: number, filter: number) => (member << 16) | filter;
