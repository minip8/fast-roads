# F1 2026 car model (`model.glb`)

Converted from LibreCorsa's F1 2026 model (`public/cars/f12026/model/f12026.glb` at commit
`02ee8ca34c32dcc0ab97be6da8e93d2f8c0f32d2` of https://github.com/KhazP/librecorsa), which combines two models:

## The car

- **Title:** F1 2026 concept (polygon model)
- **Author:** Qvist Designs (https://qvistdesigns.framer.website/)
- **Source:** https://sketchfab.com/3d-models/f1-2026-concept-polygon-model-ea3bde709b1e4dc9b0ec8557d106ed42
- **Licence:** Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/
- **Adapted by LibreCorsa** (its `CREDITS.md`): reoriented to metres, simplified from 1.16M to about 165k triangles,
  the wheels split into rim and tyre, the front and rear wing flaps cut free and capped so they move, and the grey
  model painted in livery zones.

## The steering wheel

- **Title:** AM26 (its Sketchfab title: "AM26 | F1 25/F1 2026 DLC")
- **Author:** DeX
- **Source:** https://sketchfab.com/3d-models/am26-f1-25f1-2026-dlc-cbb8d4752e6d42b98b5a3eb23e4831a4
- **Licence:** labelled Creative Commons Attribution (CC BY 4.0) on Sketchfab. Its description there says the model
  was taken from the game F1 25, so that licence may not be the uploader's to give.
- LibreCorsa took only its steering wheel (with its shift lights and display) and fitted it to the car above.

## This file

`model.glb` is an adaptation of both and is licensed under CC BY 4.0. This licence is not the game code's. The
livery is this game's own, in the colours of the car's built body; it carries no team's names or logos.

Made by `scripts/cars/convert.mjs` (see its header to reproduce it from the download):

- Placed on this game's car (its wheelbase, 3.40 m, is the model's; the axles moved to the car's centre of mass, the
  tyres on the road) and split into separately moving parts: the body, the four wheels (tyre and rim), the four
  brake drums, the steering wheel (with its display and shift lights), the rain light (lit under braking), and the
  six wing flaps, each with the turn that opens it (from LibreCorsa's open and closed poses).
- Simplified from about 177,000 to about 99,000 triangles; the cockpit and the steering wheel the least.
- Painted: the three paint zones navy, black and red, with new colours and finishes for the carbon, tyres and rims;
  the steering wheel's flag lights beside its screen unlit; the specular extension removed from the cockpit
  material (plain metal/roughness).
- The steering wheel's two textures re-encoded as WebP; geometry quantized and meshopt-compressed.
