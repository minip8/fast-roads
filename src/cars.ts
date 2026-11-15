import type { EngineVoice } from './audioGraph';
import { buildCarMesh, buildDriftMesh, buildGt3Mesh, type CarMesh } from './carMeshes';

export interface PacejkaCoeffs { B: number; C: number; E: number }
// One axle's brush tyre (`brush` in car.ts). Cornering force peaks at slip angle `peak` (rad) when the tyre carries
// fz0 (N), and the angle grows by the share peakGain per fz0 of extra load. Past the peak the force falls towards
// `level` of it, at `slope` per unit of tan(slip angle). Grip follows (load / fz0)^(loadExp - 1): 1 at fz0, less per
// newton as the load rises.
export interface BrushTyre { peak: number; peakGain: number; fz0: number; loadExp: number; level: number; slope: number }
type Box = [hx: number, hy: number, hz: number, x: number, y: number, z: number];

// Car specs. Every per-car number (physics, engine, sound, autopilot, cameras) lives here, so cars can differ.
// Values that only one car uses are neutral on the others (e.g. brakeKick 0), so behaviour stays per-car.
export interface CarSpec {
  id: CarId; name: string;
  hint?: string;                            // how to drive it, shown under the name when the player switches to it
  storeKey: string;                         // this car's suffix on the circuit's localStorage key for best times
  mesh: (spec: CarSpec) => CarMesh;
  // body
  mass: number;
  inertia: { x: number; y: number; z: number };   // pitch, yaw, roll (body axes)
  comHeight: number; wheelRadius: number; trackHalf: number;
  forceHeight: number;                      // m above the road at which the tyres' grip acts on the body: above 0, the car rolls and pitches less than its centre of mass height says
  zFront: number; zRear: number;            // axle positions relative to the centre of mass (m)
  hull: Box;                                // main collider (hits ground and walls)
  parts: Box[];                             // wall-only colliders
  // suspension
  suspLen: number; kFront: number; kRear: number; damp: number; arbFront: number; arbRear: number;
  // aero
  ClA: number; CdA: number; aeroFront: number; rho: number;
  // brakes and grip
  brakeMax: number; brakeFront: number;
  gripFront: number; gripRear: number;
  absMin: number;                           // brakes always get at least this share of a tyre's grip
  brakeGrip: number;                        // braking grip relative to cornering grip (1 = the same)
  driveGrip: number;                        // traction under power relative to cornering grip (1 = the same)
  brakeKick: number;                        // rear grip lost when braking while turning
  // Countersteer assist for the player (see Car.step): wheel angle added per radian of rear slide past fromSlip
  // (rad); damp (s) times how fast the slide is changing; and the driver's steering into the slide fades out over
  // span (rad) of slide past fromSlip. Gain 0 turns it off.
  counterSteer: [gain: number, fromSlip: number, damp: number, span: number];
  tcSlack: number;                          // wheelspin traction control still allows (share of tyre grip)
  spinDrive: number;                        // share of its traction a spinning driven tyre keeps whatever its cornering force (0 = friction circle only)
  spinLat: number;                          // share of its cornering force a spinning driven tyre keeps (0 = friction circle only)
  // rear grip lost at low speed on the throttle, faded out by this speed (m/s). offThrottle = share of that loss
  // that remains when coasting (1 = always the same); steerIn = share that steering into the turn brings; ease =
  // seconds over which it comes and goes
  rearLoose: [share: number, fadedBy: number, offThrottle: number, ease: number, steerIn: number];
  // slide angles (rad) between which that looseness fades out again, and the share of extra rear grip gained by then
  rearCatch: [from: number, by: number, extra: number];
  pac?: PacejkaCoeffs;                      // lateral tyre curve (rear, and front unless pacFront is set)
  pacFront?: PacejkaCoeffs;
  brush?: { front: BrushTyre; rear: BrushTyre };   // brush tyres instead: their own curve and load sensitivity
  // engine and gearbox
  gearTop: number[];                        // m/s at redline per gear (index 0 unused)
  redline: number; idle: number;
  torque: [rpm: number, nm: number][];
  shiftPoint: number; overRev: number; shiftLightsFrom: number;
  launchRpm: number; engineBrake: number; reverseForce: number; reverseTop: number;   // reverse drive (N), fading out by reverseTop (m/s)
  // what the engine has to spin up besides moving the car (kg m2): engine and gearbox at the crank, and the four wheels
  rotInertia: [engine: number, wheels: number];
  // steering: [lock (rad), speed (m/s) at which the lock halves]
  steerLock: number; steerAnalog: [number, number]; steerKeys: [number, number]; steerRateKeys: number;
  steerRateAnalog: number;                  // how fast the wheels follow a mouse or stick (rad/s)
  steerComply: number;                      // steering flex: rad a front wheel gives towards straight per N of its cornering force (0 = rigid)
  counterLock: [perSlide: number, rate: number];   // steering into a slide: lock per radian of slide, and how much faster the keys wind it on
  angDamp: number;
  yawCap: [margin: number, latAccel: number, gain: number];   // soft limit on yaw rate: margin (rad/s) over latAccel (m/s2) / speed; excess decays at gain (1/s); gain 0 = off
  sound: EngineVoice;                       // engine and tyre sound (audioGraph.ts)
  // autopilot
  autoGrip: number; autoLong: number; autoCounter: number; autoLift: number;
  autoUndersteer: number;                   // extra lock the autopilot adds per m/s2 of cornering (rad), for a car that understeers
  // visuals
  tyreW: [front: number, rear: number];
  cam: { up: number; back: number; down: number };   // onboard camera offset
}

export type CarId = 'f1' | 'drift' | 'gt3';

const GT3_CAMBER = 1.03;  // cornering grip the outside tyres gain from the camber they run (-3.5 deg front, -2.5 rear)
const GT3_TORQUE = 1.04; // LibreCorsa's fit of the engine to the reference laps

export const CARS: Record<CarId, CarSpec> = {
  f1: {
    id: 'f1', name: 'F1', storeKey: '', mesh: buildCarMesh,
    mass: 798,
    inertia: { x: 950, y: 1050, z: 260 },   // pitch, yaw, roll (body axes)
    comHeight: 0.30, forceHeight: 0.12,
    wheelRadius: 0.33,
    trackHalf: 0.80,
    zFront: 1.9, zRear: -1.5,
    suspLen: 0.20,                // full extension
    kFront: 70000, kRear: 85000,  // spring N/m
    damp: 4800,                   // N per m/s
    arbFront: 26000, arbRear: 18000,
    ClA: 4.2, CdA: 1.5, aeroFront: 0.40, rho: 1.225,
    brakeMax: 42000, brakeFront: 0.55,
    gripFront: 1.0, gripRear: 1.1,     // rear tyres are wider
    absMin: 0.45,                     // brakes always get at least this share of a tyre's grip
    brakeGrip: 1, driveGrip: 1,       // braking grip and traction relative to cornering grip
    brakeKick: 0,                     // rear grip lost when braking while turning (see Car.step)
    counterSteer: [0, 1, 0, 1],       // countersteer assist off: [gain, rear slide (rad) it starts from, damp, span]
    tcSlack: 0.04,                    // wheelspin traction control still allows (share of tyre grip)
    spinLat: 0, spinDrive: 0,         // cornering force and traction kept under wheelspin (0 = plain friction circle)
    rearCatch: [9, 10, 0],
    rearLoose: [0, 1, 1, 0, 1],             // rear grip lost at low speed: [share, speed (m/s) it has faded out by, off-throttle share]
    pac: { B: 11, C: 1.45, E: 0.15 },
    gearTop: [0, 26, 36, 45, 54, 63, 72, 81, 90],   // m/s at redline per gear
    redline: 12500, idle: 4500,
    torque: [[4000, 330], [6000, 430], [8000, 520], [10000, 600], [11500, 615], [12500, 570], [12900, 0]],   // rpm, Nm
    shiftPoint: 12250, overRev: 13000, shiftLightsFrom: 9500,
    launchRpm: 6500, engineBrake: 1100, reverseForce: 3500, reverseTop: 10,
    rotInertia: [0, 0],
    steerLock: 0.4, steerAnalog: [0.36, 45], steerKeys: [0.34, 22], steerRateKeys: 1,   // [lock, speed it halves at]
    steerRateAnalog: 6,
    steerComply: 0,
    counterLock: [0, 1],
    angDamp: 0.4,
    yawCap: [0, 0, 0],
    // V6 turbo at 12,500 rpm: smooth, even orders, bright and nasal.
    sound: {
      firingDiv: 20,
      harmonics: [0.12, 1, 0.18, 0.55, 0.1, 0.36, 0.07, 0.22, 0.05, 0.14, 0.03, 0.09, 0.02, 0.05],
      detune: 6, level: 0.17, coast: 0.42, bright: [2.2, 6.5], body: [1500, 1.2, 1, 4], rough: 0.06, squealHz: 950,
    },
    autoGrip: 0.68, autoLong: 1.2,   // autopilot's assumed lateral grip share / braking (g)
    autoCounter: 0,                  // autopilot counter-steer per radian of slide
    autoLift: 0,                     // autopilot throttle cut per radian of slide
    autoUndersteer: 0,
    hull: [0.62, 0.14, 2.3, 0, 0.02, 0.2],                                // half extents + offset: [hx, hy, hz, x, y, z]
    parts: [[0.95, 0.1, 0.3, 0, -0.12, 2.75], [0.5, 0.25, 0.25, 0, 0.45, -2.0]],   // wall-only colliders
    tyreW: [0.32, 0.4],
    cam: { up: 0.98, back: 0.3, down: 1.1 },
  },
  // Rear-drive coupe: light, little downforce, lots of torque, loose rear. The tail swings a long way out and digs
  // in before it comes all the way round; opposite lock brings it back. Best with TC off.
  drift: {
    id: 'drift', name: 'Drift car', storeKey: '.drift', mesh: buildDriftMesh,
    hint: 'The throttle slides it: turn in on the power and the tail swings out and holds · lift off to straighten',
    mass: 1000,
    inertia: { x: 1360, y: 1700, z: 384 },   // enough yaw inertia that the tail swings rather than snaps
    comHeight: 0.45, forceHeight: 0.12,
    wheelRadius: 0.33,
    trackHalf: 0.80,
    zFront: 1.3, zRear: -1.3,
    suspLen: 0.25,
    kFront: 40000, kRear: 36000,
    damp: 4160,
    arbFront: 11200, arbRear: 20800,   // stiffer rear bar: the rear lets go first in corners
    ClA: 0.3, CdA: 0.75, aeroFront: 0.45, rho: 1.225,
    brakeMax: 17600, brakeFront: 0.68,   // front-biased, so braking doesn't swap the ends
    gripFront: 0.86, gripRear: 0.96,   // the rear must out-grip the front at speed or the car turns itself round
    // ...but loses this share of grip at low speed (fading out by this speed, m/s) on the throttle, half of that
    // when steering into the turn, and about a third of it when coasting: lifting off gives the rear its grip back.
    // It comes and goes over 0.3 s, so the tail swings out rather than snapping.
    rearLoose: [0.36, 50, 0.35, 0.3, 0.5],
    // ...and past 14 deg of slide the looseness fades, gone by 40 with 10% more grip on top: the tail digs in, so a
    // slide settles at about 30 deg for as long as the throttle is down instead of running on round
    rearCatch: [0.25, 0.7, 0.1],
    absMin: 0.3,
    brakeGrip: 1.08,                   // the tyres stop a little harder than they corner (about 1.4 g)
    driveGrip: 1.12,                   // ...and put power down a little better too
    brakeKick: 0.25,
    // optional assist (off unless the player turns it on): catches slides past ~8 deg; a held key settles near 30 deg
    counterSteer: [1.2, 0.14, 0.3, 0.45],
    tcSlack: 0.25,                     // lenient TC: the throttle can still swing the rear
    // wheelspin leaves the rear most of its cornering force: power slides build gradually, and a sliding car turns
    // (its path follows its nose) instead of spending the rear tyres on gaining speed
    spinLat: 0.9, spinDrive: 0.7,
    pac: { B: 9, C: 1.35, E: 0.1 },    // rear: grip barely drops off past the peak, so a big slide can still be caught
    pacFront: { B: 10, C: 1.25, E: 0.1 },   // front: holds grip when over-steered, so it doesn't wash wide
    gearTop: [0, 14, 22, 30, 39, 49, 60],
    redline: 7500, idle: 1000,
    torque: [[1000, 345], [2500, 460], [4000, 540], [5000, 552], [6500, 518], [7500, 460], [7800, 0]],
    shiftPoint: 7200, overRev: 7700, shiftLightsFrom: 5200,
    launchRpm: 3500, engineBrake: 480, reverseForce: 3600, reverseTop: 12,
    rotInertia: [0, 0],
    // steerLock is the wheels' full travel; steering into a corner uses less, the rest is for opposite lock
    steerLock: 0.9, steerAnalog: [0.6, 90], steerKeys: [0.5, 50], steerRateKeys: 2.6,   // quick keys: opposite lock in about 0.2 s
    // opposite lock: 0.4 of the slide angle, which leaves the slide to the throttle (held with it down, back when
    // you lift) rather than dragging the nose straight, wound on up to twice as fast
    counterLock: [0.4, 2],
    steerRateAnalog: 6,
    steerComply: 0,
    angDamp: 0.25,
    yawCap: [0.5, 12, 10],             // the tail can swing about 30 deg/s faster than the car can corner, no more
    // Cross-plane V8 at 7,500 rpm: strong half orders give the lumpy burble, darker overall.
    sound: {
      firingDiv: 15,
      harmonics: [0.6, 1, 0.5, 0.45, 0.3, 0.28, 0.16, 0.15, 0.1, 0.08, 0.06, 0.05],
      detune: 9, level: 0.2, coast: 0.4, bright: [2.5, 7], body: [260, 1.0, 2, 5], rough: 0.22, squealHz: 780,
    },
    autoGrip: 0.6, autoLong: 0.75, autoCounter: 0.9, autoLift: 6, autoUndersteer: 0,
    hull: [0.82, 0.28, 2.15, 0, 0.18, 0],
    parts: [[0.7, 0.2, 0.95, 0, 0.53, -0.35]],
    tyreW: [0.25, 0.27],
    cam: { up: 0.6, back: -1.0, down: 0.35 },  // bonnet camera, just ahead of the windscreen
  },
  // GT3 coupe: the Mercedes-AMG GT3 of LibreCorsa (github.com/KhazP/librecorsa, MIT; src/lib/sim/gt3/AmgGt3Config.ts),
  // whose data is fitted to real GT3 telemetry. The chassis, springs, anti-roll bars, tyres, engine, gearing and aero
  // are that car's numbers. Four are fitted instead, so that this physics reproduces the cornering, braking,
  // acceleration and understeer LibreCorsa measures from its own simulation (test/gt3.test.ts holds the table):
  // GT3_CAMBER, brakeMax, brakeGrip and steerComply.
  gt3: {
    id: 'gt3', name: 'GT3', storeKey: '.gt3', mesh: buildGt3Mesh,
    hint: 'Heavy and planted: brake early and in a straight line, and wait for the nose before the power',
    mass: 1385,                               // 1360 kg with driver, plus the 25 kg of fuel aboard on the reference laps
    inertia: { x: 1791, y: 2039, z: 470 },    // a 1.78 x 0.99 x 3.85 m box of 1360 kg
    comHeight: 0.40, forceHeight: 0,          // the full load transfer of a 0.40 m centre of mass
    wheelRadius: 0.345,                       // 0.340 front, 0.3525 rear
    trackHalf: 0.87,                          // 1.75 m front, 1.72 m rear
    zFront: 1.378, zRear: -1.272,             // 2.65 m wheelbase, 48% of the weight on the front
    suspLen: 0.12,
    kFront: 171000, kRear: 127000,            // wheel rates: a stiff front platform (3.2 Hz)
    damp: 12000,
    arbFront: 68400, arbRear: 40200,          // 60% of the roll stiffness at the front
    // splitter 0.94 + floor 0.74 + wing 0.82 m2 of downforce at the static ride height; sea-level air as in their runs
    ClA: 2.5, CdA: 0.87, aeroFront: 0.45, rho: 1.2,
    brakeMax: 26000, brakeFront: 0.717,       // 4750 Nm a wheel, 71% of it at the front, is 27650 N: their car uses 94% of it at speed
    gripFront: GT3_CAMBER * 1.9007 / 1.65, gripRear: GT3_CAMBER * 1.9236 / 1.65,   // peak grip at fz0, over the asphalt's 1.65
    absMin: 0.45,
    // The slick drives 3.3% less hard than it corners (and gets no camber gain), and their car brakes at about 1.5 g
    // plus downforce.
    brakeGrip: 0.825, driveGrip: 0.94,
    brakeKick: 0,
    counterSteer: [0, 1, 0, 1],
    tcSlack: 0.04,
    spinLat: 0, spinDrive: 0,
    rearCatch: [9, 10, 0],
    rearLoose: [0, 1, 1, 0, 1],
    // 315/680-18 front and 325/705-18 rear slicks: peak at 6.1 deg, then a gentle fall to 85%
    brush: {
      front: { peak: 0.1068, peakGain: 0.043, fz0: 3787, loadExp: 0.7917, level: 0.85, slope: 5 },
      rear: { peak: 0.1058, peakGain: 0.035, fz0: 3910, loadExp: 0.8044, level: 0.85, slope: 5 },
    },
    // 6-speed sequential: 232 / 181 / 141 / 115 / 101 / 89 rpm per m/s
    gearTop: [0, 34.0, 43.6, 55.9, 68.5, 78.4, 88.6],
    redline: 7900, idle: 2100,
    // 6.2 l V8, torque at the wheels' end of the driveline: 566 Nm at 6000 rpm, 374 kW at 7000
    torque: ([[1000, 280], [1500, 330], [2000, 350], [2500, 410], [3000, 450], [3500, 470], [4000, 506], [4500, 517], [5000, 524],
      [5500, 534], [6000, 544], [6500, 520], [7000, 490], [7500, 450], [7900, 410], [8100, 0]] as [number, number][]).map(([rpm, nm]) => [rpm, nm * GT3_TORQUE]),
    shiftPoint: 7500, overRev: 8400, shiftLightsFrom: 5800,
    launchRpm: 3000, engineBrake: 1200, reverseForce: 4500, reverseTop: 10,
    rotInertia: [0.148, 6.8],                 // in 1st gear, like 145 kg more car to accelerate
    steerLock: 0.443, steerAnalog: [0.42, 40], steerKeys: [0.36, 26], steerRateKeys: 1,   // 320 deg of wheel on a 12.6 rack
    steerRateAnalog: 6,
    steerComply: 5.9e-6,                      // 0.34 deg per kN (theirs 0.28, plus the bump steer this car lacks): most of its 1.4 deg/g of understeer
    counterLock: [0, 1],
    angDamp: 0.3,
    yawCap: [0, 0, 0],
    // Flat-out 6.2 l V8 at 7,900 rpm: the drift car's lumpy half orders, but harder and brighter.
    sound: {
      firingDiv: 15,
      harmonics: [0.5, 1, 0.45, 0.6, 0.3, 0.4, 0.2, 0.25, 0.12, 0.14, 0.08, 0.08],
      detune: 7, level: 0.2, coast: 0.4, bright: [2.6, 8], body: [320, 1.1, 2, 5], rough: 0.16, squealHz: 850,
    },
    autoGrip: 0.72, autoLong: 1.25, autoCounter: 0, autoLift: 0,
    autoUndersteer: 0.0025,                   // its 1.4 deg/g
    hull: [0.95, 0.22, 2.3, 0, 0.05, -0.04],
    parts: [[0.72, 0.2, 0.95, 0, 0.5, -0.45], [0.95, 0.05, 0.2, 0, 0.8, -2.2]],   // cabin, rear wing
    tyreW: [0.315, 0.325],
    cam: { up: 0.5, back: -0.7, down: 0.3 },   // bonnet camera, ahead of the windscreen
  },
};
