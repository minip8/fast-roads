import type { EngineVoice } from './audioGraph';
import { buildCarMesh, buildDriftMesh, buildGt3Mesh, type CarMesh, LC_GT3_MODEL, type Paint } from './carMeshes';
import type { EngineDriverFactory } from './lc/engineDriver';
import { f1Driver, gt3Driver } from './lc/driver';
import { compoundData, type CarPhysicsConfig } from './lc/vendor/sim/f12026-car/F12026CarConfig';
import { LC26_TUNED_CONFIG } from './lc/vendor/sim/f12026-car/Lc26Tune';
import { AMG_GT3_CONFIG } from './lc/vendor/sim/gt3/AmgGt3Config';

export interface PacejkaCoeffs { B: number; C: number; E: number }
type Box = [hx: number, hy: number, hz: number, x: number, y: number, z: number];

// The physics engines a car can run on: 'rapier' is ours (Car in car.ts), 'lc' LibreCorsa's (LcCar in lc/lcCar.ts).
// createVehicle (sim.ts) builds each.
export type PhysicsId = 'rapier' | 'lc';

// What the rest of the game reads from a car's spec, whichever engine drives it: the menu and best times, the body
// for the meshes and autopilot, the engine for the HUD and sound, the cameras, and what the autopilot plans with.
export interface CarInfo {
  id: CarId; name: string;
  hint?: string;                            // how to drive it, shown under the name when the player switches to it
  storeKey: string;                         // this car's suffix on the circuit's localStorage key for best times
  physics: PhysicsId;                       // which engine drives it
  mesh: (spec: CarInfo) => CarMesh;
  // body
  mass: number;
  comHeight: number; wheelRadius: number; trackHalf: number;
  zFront: number; zRear: number;            // axle positions relative to the centre of mass (m)
  // aero and grip (the autopilot's speed plan)
  ClA: number; rho: number;
  gripFront: number; gripRear: number;
  // engine: rpm range, auto upshift point and the shift lights' start
  redline: number; idle: number;
  shiftPoint: number; shiftLightsFrom: number;
  sound: EngineVoice;                       // engine and tyre sound (audioGraph.ts)
  // autopilot
  autoGrip: number; autoLong: number; autoCounter: number; autoLift: number;
  autoUndersteer: number;                   // extra lock the autopilot adds per m/s2 of cornering (rad), for a car that understeers
  // visuals
  tyreW: [front: number, rear: number];
  cam: { up: number; back: number; down: number };   // onboard camera offset
}

// Car specs for our physics (the drift car). Every per-car number (physics, engine, sound, autopilot, cameras) lives
// here. Each handling feature has a neutral value that turns it off (e.g. brakeKick 0, yawCap gain 0), so another car
// on this physics can leave out what it does not want.
export interface CarSpec extends CarInfo {
  physics: 'rapier';
  // body
  inertia: { x: number; y: number; z: number };   // pitch, yaw, roll (body axes)
  forceHeight: number;                      // m above the road at which the tyres' grip acts on the body: above 0, the car rolls and pitches less than its centre of mass height says
  hull: Box;                                // main collider (hits ground and walls)
  parts: Box[];                             // wall-only colliders
  // suspension
  suspLen: number; kFront: number; kRear: number; damp: number; arbFront: number; arbRear: number;
  // aero
  CdA: number; aeroFront: number;
  // brakes and grip
  brakeMax: number; brakeFront: number;
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
  pac: PacejkaCoeffs;                       // lateral tyre curve (rear, and front unless pacFront is set)
  pacFront?: PacejkaCoeffs;
  // engine and gearbox
  gearTop: number[];                        // m/s at redline per gear (index 0 unused)
  torque: [rpm: number, nm: number][];
  overRev: number;
  launchRpm: number; engineBrake: number; reverseForce: number; reverseTop: number;   // reverse drive (N), fading out by reverseTop (m/s)
  // steering: [lock (rad), speed (m/s) at which the lock halves]
  steerLock: number; steerAnalog: [number, number]; steerKeys: [number, number]; steerRateKeys: number;
  steerRateAnalog: number;                  // how fast the wheels follow a mouse or stick (rad/s)
  counterLock: [perSlide: number, rate: number];   // steering into a slide: lock per radian of slide, and how much faster the keys wind it on
  angDamp: number;
  yawCap: [margin: number, latAccel: number, gain: number];   // soft limit on yaw rate: margin (rad/s) over latAccel (m/s2) / speed; excess decays at gain (1/s); gain 0 = off
}

// A car on LibreCorsa's engine: its car data, as theirs, and what our adapter (LcCar) adds around it. The CarInfo
// geometry is read from the car data (lcBody).
export interface LcSpec extends CarInfo {
  physics: 'lc';
  config: CarPhysicsConfig;                 // LibreCorsa's car (each car built gets its own copy)
  driver: EngineDriverFactory;              // pedals, steering and aids between our DriveInput and the engine
  fuelKg: number;                           // on board at the start (their garage default); never burnt
  turbo: boolean;
  straightMode: boolean;                    // 2026 F1: flaps fitted, opening by themselves on every straight
}

// A spec for any engine: a union of each engine's spec type, told apart by `physics`.
export type AnyCarSpec = CarSpec | LcSpec;

export type CarId = 'drift' | 'lcgt3' | 'lcf1';

// Whether the Countersteer assist setting does anything on this car.
export const hasAssist = (spec: AnyCarSpec) => spec.physics === 'rapier' && spec.counterSteer[0] !== 0;

// V6 turbo at 12,500 rpm: smooth, even orders, bright and nasal.
const F1_VOICE: EngineVoice = {
  firingDiv: 20,
  harmonics: [0.12, 1, 0.18, 0.55, 0.1, 0.36, 0.07, 0.22, 0.05, 0.14, 0.03, 0.09, 0.02, 0.05],
  detune: 6, level: 0.17, coast: 0.42, bright: [2.2, 6.5], body: [1500, 1.2, 1, 4], rough: 0.06, squealHz: 950,
};
// 6.2 l cross-plane V8 (the AMG M159) at 7,900 rpm, side exits: synthesised loops (engineLoops.ts). The oscillator
// numbers are its voice for the moment its loops take to make, and set the level.
const GT3_VOICE: EngineVoice = {
  firingDiv: 15,
  harmonics: [0.5, 1, 0.45, 0.6, 0.3, 0.4, 0.2, 0.25, 0.12, 0.14, 0.08, 0.08],
  detune: 7, level: 0.2, coast: 0.4, bright: [2.6, 8], body: [320, 1.1, 2, 5], rough: 0.16, squealHz: 850,
  loops: {
    firing: [0, 1, 0, 1, 1, 0, 1, 0],         // 1-5-4-8-6-3-7-2, cylinders 1-4 on one bank
    rpms: [2000, 2800, 3900, 5300, 7000, 8400],
    pipes: [1.15, 1.22], exitGap: 0.15,
    level: 3, rough: 0.08, crackle: 0.5, whine: [38, 0.01],
  },
};

// The body numbers of a LibreCorsa car from its data, for our meshes and autopilot: mass with its fuel, centre of
// mass height, axles from the wheelbase and weight split, the mean of the two axles' track and soft tyre radius.
function lcBody(config: CarPhysicsConfig, fuelKg: number) {
  const ch = config.chassis, t = compoundData(config, config.compoundSlots.soft);
  return {
    mass: ch.totalMassKg + fuelKg, comHeight: ch.cgHeight,
    zFront: ch.wheelbase * (1 - ch.frontWeightFraction), zRear: -ch.wheelbase * ch.frontWeightFraction,
    trackHalf: (ch.trackWidthFront + ch.trackWidthRear) / 4, wheelRadius: (t.front.radius + t.rear.radius) / 2,
    tyreW: [t.front.width, t.rear.width] as [number, number],
  };
}
const LC_GT3_PAINT: Paint = { body: 0xc3c7cc, accent: 0x00a19b, stripe: 0x00a19b };   // silver, teal (the built body, until its model loads)
const LC_F1_PAINT: Paint = { body: 0x1b2a4e, accent: 0xe8112d, stripe: 0xf5f5f5 };   // navy, red

export const CARS: Record<CarId, AnyCarSpec> = {
  // LibreCorsa's 2026 F1 car (the LC26, tuned) on their engine: 768 kg, a hybrid that deploys and harvests by itself
  // (RAC mode), and flaps that open on every straight.
  lcf1: {
    id: 'lcf1', name: 'F1 2026', storeKey: '.lcf1', physics: 'lc', mesh: (spec) => buildCarMesh(spec, LC_F1_PAINT),
    hint: 'LibreCorsa physics: hybrid and flaps work themselves · ABS always on · keep TC on unless you like spinning',
    config: LC26_TUNED_CONFIG, driver: f1Driver, fuelKg: 35, turbo: true, straightMode: true,
    ...lcBody(LC26_TUNED_CONFIG, 35),
    rho: 1.225,
    ClA: 5.0,                                 // measured on the engine, flaps shut: 2.75 N per (m/s)^2 at 108 km/h, 3.19 from 180
    gripFront: 1.63 / 1.65, gripRear: 1.63 / 1.65,   // their autopilot's cornering mu 1.63 (Lc26Sim)
    autoGrip: 0.85, autoLong: 1.2,            // 0.85 of their envelope's 1.6 g low-speed braking
    autoCounter: 0, autoLift: 0,
    autoUndersteer: 0,                        // their plan computes none for it
    redline: 12500, idle: 4000, shiftPoint: 12200, shiftLightsFrom: 10800,
    sound: F1_VOICE,
    cam: { up: 0.98, back: 0.3, down: 1.1 },
  },
  // LibreCorsa's Mercedes-AMG GT3 on their engine (src/lc/vendor).
  lcgt3: {
    id: 'lcgt3', name: 'GT3', storeKey: '.lcgt3', physics: 'lc', mesh: (spec) => buildGt3Mesh(spec, LC_GT3_PAINT, LC_GT3_MODEL),
    hint: 'LibreCorsa physics: tyres warm up over the first corners · ABS always on · with TC off the throttle steers it',
    config: AMG_GT3_CONFIG, driver: gt3Driver, fuelKg: 50, turbo: false, straightMode: false,
    ...lcBody(AMG_GT3_CONFIG, 50),
    rho: 1.225,                               // sea level, as their adapter runs it
    ClA: 2.5,                                 // measured on the engine: 1.53 N per (m/s)^2 of downforce at 108-252 km/h
    // Their autopilot's cornering mu 1.6 (AmgGt3Sim), over our asphalt's 1.65 that the plan multiplies by
    gripFront: 1.6 / 1.65, gripRear: 1.6 / 1.65,
    autoGrip: 0.85, autoLong: 1.2,            // 0.85 of their envelope's 1.7 g low-speed braking, as their plan takes it
    autoCounter: 0, autoLift: 0,
    autoUndersteer: 0.0025,                   // the 1.41 deg/g their reference manoeuvre measures on this engine
    redline: 7900, idle: 2100, shiftPoint: 7500, shiftLightsFrom: 6200,   // their limiter, idle, upshift and shift lights
    sound: GT3_VOICE,
    cam: { up: 0.58, back: -0.8, down: 0.3 },
  },
  // Rear-drive coupe: light, little downforce, lots of torque, loose rear. The tail swings a long way out and digs
  // in before it comes all the way round; opposite lock brings it back. Best with TC off.
  drift: {
    id: 'drift', name: 'Drift car', storeKey: '.drift', physics: 'rapier', mesh: buildDriftMesh,
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
    // steerLock is the wheels' full travel; steering into a corner uses less, the rest is for opposite lock
    steerLock: 0.9, steerAnalog: [0.6, 90], steerKeys: [0.5, 50], steerRateKeys: 2.6,   // quick keys: opposite lock in about 0.2 s
    // opposite lock: 0.4 of the slide angle, which leaves the slide to the throttle (held with it down, back when
    // you lift) rather than dragging the nose straight, wound on up to twice as fast
    counterLock: [0.4, 2],
    steerRateAnalog: 6,
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
};
