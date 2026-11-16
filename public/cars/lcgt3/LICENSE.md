# GT3 car model (`model.glb`)

- **Title:** Mercedes-AMG GT3 Red Bull Racing
- **Author:** VTX (Sketchfab user `VTX_car`)
- **Source:** https://sketchfab.com/3d-models/mercedes-amg-gt3-red-bull-racing-035f061cb6624effbc483d5f9b5ecaba
- **Licence:** Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0),
  https://creativecommons.org/licenses/by-nc-sa/4.0/
- **Based on:** "Mercedes-Benz AMG GT3 Red Bull" by toddeppe,
  https://sketchfab.com/3d-models/mercedes-benz-amg-gt3-red-bull-83c34fe5c0d64d838bc3c5e0f2d7f56a , which derives
  from "Mercedes-AMG GT3 | www.vecarz.com" by Vecarz,
  https://sketchfab.com/3d-models/mercedes-amg-gt3-wwwvecarzcom-6a3f7e3455064721b74b7f0b66427a07 (CC BY-NC-SA 4.0).

`model.glb` is an adaptation of that model and is licensed under CC BY-NC-SA 4.0 too. It is not covered by the
licence of this game's code: it may not be used commercially, and adaptations of it must carry the same licence.
The livery's names and logos (Red Bull, Mercedes-AMG, sponsors) are trademarks of their owners; this is an
unofficial model, not affiliated with or endorsed by Red Bull, Mercedes-Benz or Mercedes-AMG.

## Changes made

Made by `scripts/cars/convert.mjs` (see its header to reproduce it from the original download):

- Turned and scaled to this game's axes and car dimensions (wheelbase 2.65 m, its tyres on the road), and split
  into separately moving parts: the body, the four wheels (tyre, rim, brake disc), the four brake calipers, the
  steering wheel (with the button labels, which the original keeps in the interior stickers mesh) and the rear
  lights (lit under braking).
- Removed one mesh with a placeholder grid material, and the glass and window-tint faces that face into the
  cabin.
- Simplified from about 497,000 to about 153,000 triangles: the cabin barely, hidden parts (engine bay,
  suspension, the interior behind the seats) the most.
- Materials: the transmission, clearcoat and specular extensions removed (plain metal/roughness), the window glass
  made a tinted transparent colour, and the tiling carbon-weave normal maps dropped.
- Textures resized (at most 2048 px for the livery, 1024 px for other colour maps, 512 px for normal and other maps) and re-encoded as WebP; geometry
  quantized and meshopt-compressed.
