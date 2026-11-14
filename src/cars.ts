import type { EngineVoice } from './audioGraph';
import { buildCarMesh, buildDriftMesh, type CarMesh } from './carMeshes';

export interface PacejkaCoeffs { B: number; C: number; E: number }
type Box = [hx: number, hy: number, hz: number, x: number, y: number, z: number];

// Car specs. Every per-car number (physics, engine, sound, autopilot, cameras) lives here, so cars can differ.
// Values that only one car uses are neutral on the others (e.g. brakeKick 0), so behaviour stays per-car.
export interface CarSpec {
  id: CarId; name: string;
  storeKey: string;                         // this car's suffix on the circuit's localStorage key for best times
  mesh: (spec: CarSpec) => CarMesh;
  // body
  mass: number;
  inertia: { x: number; y: number; z: number };   // pitch, yaw, roll (body axes)
  comHeight: number; wheelRadius: number; trackHalf: number;
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
  spinLat: number;                          // share of its cornering force a spinning driven tyre keeps (0 = friction circle only)
  // rear grip lost at low speed when on the throttle or steering into the turn, faded out by this speed (m/s);
  // offThrottle = share of that loss that remains otherwise (1 = always the same)
  rearLoose: [share: number, fadedBy: number, offThrottle: number];
  rearCatch: [from: number, by: number];    // slide angles (rad) between which that looseness fades out again
  pac: PacejkaCoeffs;                       // lateral tyre curve (rear, and front unless pacFront is set)
  pacFront?: PacejkaCoeffs;
  // engine and gearbox
  gearTop: number[];                        // m/s at redline per gear (index 0 unused)
  redline: number; idle: number;
  torque: [rpm: number, nm: number][];
  shiftPoint: number; overRev: number; shiftLightsFrom: number;
  launchRpm: number; engineBrake: number; reverseForce: number; reverseTop: number;   // reverse drive (N), fading out by reverseTop (m/s)
  // steering: [lock (rad), speed (m/s) at which the lock halves]
  steerLock: number; steerAnalog: [number, number]; steerKeys: [number, number]; steerRateKeys: number;
  counterLock: [perSlide: number, rate: number];   // steering into a slide: lock per radian of slide, and how much faster the keys wind it on
  angDamp: number;
  sound: EngineVoice;                       // engine and tyre sound (audioGraph.ts)
  // autopilot
  autoGrip: number; autoLong: number; autoCounter: number; autoLift: number;
  // visuals
  tyreW: [front: number, rear: number];
  cam: { up: number; back: number; down: number };   // onboard camera offset
}

export type CarId = 'f1' | 'drift';

export const CARS: Record<CarId, CarSpec> = {
  f1: {
    id: 'f1', name: 'F1', storeKey: '', mesh: buildCarMesh,
    mass: 798,
    inertia: { x: 950, y: 1050, z: 260 },   // pitch, yaw, roll (body axes)
    comHeight: 0.30,
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
    spinLat: 0,                       // cornering force kept under wheelspin (0 = plain friction circle)
    rearCatch: [9, 10],
    rearLoose: [0, 1, 1],             // rear grip lost at low speed: [share, speed (m/s) it has faded out by, off-throttle share]
    pac: { B: 11, C: 1.45, E: 0.15 },
    gearTop: [0, 26, 36, 45, 54, 63, 72, 81, 90],   // m/s at redline per gear
    redline: 12500, idle: 4500,
    torque: [[4000, 330], [6000, 430], [8000, 520], [10000, 600], [11500, 615], [12500, 570], [12900, 0]],   // rpm, Nm
    shiftPoint: 12250, overRev: 13000, shiftLightsFrom: 9500,
    launchRpm: 6500, engineBrake: 1100, reverseForce: 3500, reverseTop: 10,
    steerLock: 0.4, steerAnalog: [0.36, 45], steerKeys: [0.34, 22], steerRateKeys: 1,   // [lock, speed it halves at]
    counterLock: [0, 1],
    angDamp: 0.4,
    // V6 turbo at 12,500 rpm: smooth, even orders, bright and nasal.
    sound: {
      firingDiv: 20,
      harmonics: [0.12, 1, 0.18, 0.55, 0.1, 0.36, 0.07, 0.22, 0.05, 0.14, 0.03, 0.09, 0.02, 0.05],
      detune: 6, level: 0.17, coast: 0.42, bright: [2.2, 6.5], body: [1500, 1.2, 1, 4], rough: 0.06, squealHz: 950,
    },
    autoGrip: 0.68, autoLong: 1.2,   // autopilot's assumed lateral grip share / braking (g)
    autoCounter: 0,                  // autopilot counter-steer per radian of slide
    autoLift: 0,                     // autopilot throttle cut per radian of slide
    hull: [0.62, 0.14, 2.3, 0, 0.02, 0.2],                                // half extents + offset: [hx, hy, hz, x, y, z]
    parts: [[0.95, 0.1, 0.3, 0, -0.12, 2.75], [0.5, 0.25, 0.25, 0, 0.45, -2.0]],   // wall-only colliders
    tyreW: [0.32, 0.4],
    cam: { up: 0.98, back: 0.3, down: 1.1 },
  },
  // Rear-drive coupe: light, little downforce, lots of torque, loose rear. The tail swings a long way out and digs
  // in before it comes all the way round; opposite lock brings it back. Best with TC off.
  drift: {
    id: 'drift', name: 'Drift car', storeKey: '.drift', mesh: buildDriftMesh,
    mass: 1000,
    inertia: { x: 1360, y: 1300, z: 384 },   // low yaw inertia: quick to turn, quick to catch
    comHeight: 0.45,
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
    // ...but loses this share of grip at low speed (fading out by this speed, m/s) on the throttle or when steering
    // into the turn, and about a third of that otherwise: lifting off and steering into a slide gives the rear its
    // grip back, which is how a slide is caught
    rearLoose: [0.34, 50, 0.35],
    rearCatch: [0.35, 0.8],            // ...and past 20 deg of slide the looseness fades, gone by 46: the tail digs in
    absMin: 0.3,
    brakeGrip: 1.08,                   // the tyres stop a little harder than they corner (about 1.4 g)
    driveGrip: 1.12,                   // ...and put power down a little better too
    brakeKick: 0.25,
    // optional assist (off unless the player turns it on): catches slides past ~8 deg; a held key settles near 30 deg
    counterSteer: [1.2, 0.14, 0.3, 0.45],
    tcSlack: 0.25,                     // lenient TC: the throttle can still swing the rear
    // wheelspin leaves the rear most of its cornering force: power slides build gradually, and a sliding car turns
    // (its path follows its nose) instead of spending the rear tyres on gaining speed
    spinLat: 0.9,
    pac: { B: 9, C: 1.35, E: 0.1 },    // rear: grip barely drops off past the peak, so a big slide can still be caught
    pacFront: { B: 10, C: 1.25, E: 0.1 },   // front: holds grip when over-steered, so it doesn't wash wide
    gearTop: [0, 14, 22, 30, 39, 49, 60],
    redline: 7500, idle: 1000,
    torque: [[1000, 345], [2500, 460], [4000, 540], [5000, 552], [6500, 518], [7500, 460], [7800, 0]],
    shiftPoint: 7200, overRev: 7700, shiftLightsFrom: 5200,
    launchRpm: 3500, engineBrake: 480, reverseForce: 3600, reverseTop: 12,
    // steerLock is the wheels' full travel; steering into a corner uses less, the rest is for opposite lock
    steerLock: 0.9, steerAnalog: [0.6, 90], steerKeys: [0.5, 50], steerRateKeys: 2.6,   // quick keys: opposite lock in about 0.2 s
    // opposite lock: 0.55 of the slide angle, which balances the sliding rear rather than overpowering it (so a
    // slide can be held on the throttle and comes back when you lift), wound on up to twice as fast
    counterLock: [0.55, 2],
    angDamp: 0.25,
    // Cross-plane V8 at 7,500 rpm: strong half orders give the lumpy burble, darker overall.
    sound: {
      firingDiv: 15,
      harmonics: [0.6, 1, 0.5, 0.45, 0.3, 0.28, 0.16, 0.15, 0.1, 0.08, 0.06, 0.05],
      detune: 9, level: 0.2, coast: 0.4, bright: [2.5, 7], body: [260, 1.0, 2, 5], rough: 0.22, squealHz: 780,
    },
    autoGrip: 0.6, autoLong: 0.75, autoCounter: 0.9, autoLift: 6,
    hull: [0.82, 0.28, 2.15, 0, 0.18, 0],
    parts: [[0.7, 0.2, 0.95, 0, 0.53, -0.35]],
    tyreW: [0.25, 0.27],
    cam: { up: 0.6, back: -1.0, down: 0.35 },  // bonnet camera, just ahead of the windscreen
  },
};
