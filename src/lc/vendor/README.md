# Vendored LibreCorsa car physics

The car physics engine of [LibreCorsa](https://github.com/KhazP/librecorsa) (`VehiclePhysics`) and the data of two
of its cars: the Mercedes-AMG GT3 Evo (`AMG_GT3_CONFIG`, `AMG_GT3_ELECTRONICS`) and the 2026 F1 car "LC26" in its
tuned config (`LC26_TUNED_CONFIG`). Only the car physics: none of their game (UI, AI, multiplayer, rendering, track
loading, audio, their game adapter `F12026CarSim.ts` or the `*Sim.ts` car profiles).

- Source: https://github.com/KhazP/librecorsa, commit `c31ac202e4890100241b86616a25e163b8a02328`.
- Licence: MIT, copyright (c) 2026 KhazP; see `LICENSE` (copied unchanged from their repository root). Some of the
  data carries extra conditions, see *Data provenance* below.
- Only external dependency: `three` (they build against 0.187; it runs on our 0.185.1).

## Files

The layout mirrors theirs: `src/lib/X` there is `X` here, and `src/types/f1.ts` is `types/f1.ts`. The set is the
whole import closure (runtime and type-only) of `sim/f12026-car/VehiclePhysics.ts`, `sim/gt3/AmgGt3Config.ts` and
`sim/f12026-car/Lc26Tune.ts`, with one type-only edge cut (see *Edits*).

| File | Lines |
| :--- | ---: |
| `sim/ac-tyre.ts` | 975 |
| `sim/aero-wake.ts` | 196 |
| `sim/auto-gearbox.ts` | 163 |
| `sim/brake-physics.ts` | 204 |
| `sim/f12026-car/ContactPatch.ts` | 139 |
| `sim/f12026-car/F12026CarConfig.ts` | 1780 |
| `sim/f12026-car/Lc26Config.ts` | 635 |
| `sim/f12026-car/Lc26Tune.ts` | 229 |
| `sim/f12026-car/TrackColliderQuery.ts` | 1572 |
| `sim/f12026-car/VehiclePhysics.ts` | 3848 |
| `sim/f12026-car/brush-tyre.ts` | 145 |
| `sim/f12026-car/settle-memo.ts` | 354 |
| `sim/f12026-car/steering-torque.ts` | 211 |
| `sim/gt3/AmgGt3Config.ts` | 804 |
| `sim/lc26-aero.ts` | 95 |
| `sim/lc26-data.ts` | 767 |
| `sim/lut.ts` | 55 |
| `sim/road-texture.ts` | 106 |
| `sim/sim-realism.ts` | 39 |
| `sim/suspension-kinematics.ts` | 721 |
| `sim/track-evolution.ts` | 539 |
| `sim/track-surfaces.ts` | 134 |
| `sim/tyre-pressure.ts` | 11 |
| `sim/wet-tyres.ts` | 334 |
| `types/f1.ts` | 666 |

## Edits

Every file is a verbatim copy except for the edits below; line numbers are unchanged everywhere, so
`diff <their file> <this file>` shows exactly these lines.

1. **`@/` alias imports rewritten to relative paths** (4 imports, all `import type`): `sim/lc26-aero.ts`,
   `sim/lc26-data.ts` and `sim/wet-tyres.ts` import `../types/f1` instead of `@/types/f1`.
2. **One type-only dependency cut** (1 line): in `types/f1.ts`, the telemetry field
   `overtakingRules?: import('@/lib/sim/overtaking-rules').OvertakingRules` is typed `unknown`. That inline type
   import would pull in `overtaking-rules.ts` and, through it, their track loader (`track-data.ts`, a track JSON, the
   speed profile and more), none of which the car physics uses. The original is kept in a comment on the same line.
3. **Unused declarations commented out for our `noUnusedLocals`** (3 lines, each marked
   `// vendored: unused ... (noUnusedLocals)`): the `evaluateRollAeroFactor` import and the `const aero` local in
   `reset()` in `sim/f12026-car/VehiclePhysics.ts`, and the `DEG2RAD` constant in `sim/suspension-kinematics.ts`.

No other change was needed for our compiler flags (`strict`, `noUnusedLocals`, `noFallthroughCasesInSwitch`).
No code was trimmed: the files still hold code our cars do not reach (DRS, ERS, wet tyres, track colliders, ...).

To update from upstream: copy the same files from a newer commit, re-apply the three edits, and check the import
closure has not grown (`npm run typecheck` fails on any missing file).

## Data provenance

From their `CREDITS.md` and the files' own headers, at the vendored commit:

- `CREDITS.md` licenses all of their source code (`src/`, `scripts/`) under MIT. Its per-asset table lists physics
  data with third-party terms for other cars only (Suzuki Liana, MTRacing 496R, the classic Nissans, "used with
  permission"); it has no entry for the GT3's or the LC26's physics data.
- **Mercedes-AMG GT3**: `CREDITS.md` credits only the GT3's 3D model (CC BY-NC-SA 4.0) and its sound bank (ported from
  TRR's Assetto Corsa mod with permission), neither of which is vendored here. `AmgGt3Config.ts` says its values are
  "calibrated to FIA GT3 homologation parameters and reference GT3 telemetry" ([spec], [est], [derived], fit to
  "reference GT3 Evo MoTeC telemetry logs (Valencia, ~24 min)", and "a second GT3 reference data set"); the sources
  of those logs and data sets are not named in `CREDITS.md`.
- **LC26**: `lc26-data.ts` says "Source: the LC26 car data package (see CREDITS.md)", with values tagged [mod]
  ("Direct extraction from mod data files"), [setup], [derived] and [assumed] (FIA 2026 regulations), and
  "Provenance, copyright & licenses: see CREDITS.md". `CREDITS.md` has no entry naming an LC26 data package or mod
  (its only LC26 entries are for sounds).
- **Third-party condition in vendored data**: `CREDITS.md` lists "F1 rain-tyre temperature / wear curves" by
  **Cxjovich**, from the "2026 Pirelli Tire Pack" for Assetto Corsa, as **CC BY-NC-SA 4.0 (used with permission;
  non-commercial, share-alike)**. Those curves are `F1_RAIN_TYRE_PACK` in `sim/wet-tyres.ts` (the pack's
  `FR_Temp_Comp_6/7.lut` temperature curves and the wear ratio from `F/R_Wear_Comp_6/7.lut`). The LC26's
  intermediate and full-wet compounds are built from them (`deriveRainCompound(..., true)` in `Lc26Config.ts`,
  `f1RainTraits` in `lc26-data.ts`), as are those of the engine's default config in `F12026CarConfig.ts`. The GT3's
  rain compounds do not use them (they keep the generic `WET_TYRE_TRAITS`). Dry running on slicks does not touch them.
