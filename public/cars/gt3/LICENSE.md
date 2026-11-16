# GT3 car model (`model.glb`)

- **Title:** Mercedes-AMG GT3 | www.vecarz.com
- **Author:** Vecarz (Sketchfab user `heynic`), https://www.vecarz.com
- **Source:** https://sketchfab.com/3d-models/mercedes-amg-gt3-wwwvecarzcom-6a3f7e3455064721b74b7f0b66427a07
- **Licence:** Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0),
  https://creativecommons.org/licenses/by-nc-sa/4.0/

`model.glb` is an adaptation of that model and is licensed under CC BY-NC-SA 4.0 too. It is not covered by the
licence of this game's code: it may not be used commercially, and adaptations of it must carry the same licence.
Mercedes-AMG and Mercedes-Benz names and logos are trademarks of their owners; this is an unofficial model, not
affiliated with or endorsed by Mercedes-Benz or Mercedes-AMG.

## Changes made

Made by `scripts/cars/convert.mjs` (see its header to reproduce it from the original download):

- Turned and scaled to this game's axes and car dimensions (wheelbase 2.65 m, its tyres on the road), and split
  into separately moving parts: the body, the four wheels (tyre, rim, brake disc), the four brake calipers, the
  steering wheel and the brake lights.
- Removed parts: motion-blur rims, engine pistons, the seat belts (the game seats its own driver), stacked
  dashboard display overlays, an alternative roof banner and an interior light.
- Simplified from about 302,000 to about 121,000 triangles, the cabin barely (the driver camera sees it up close).
- Materials: the livery, banner and logo textures supplied with the download applied to the paint, banner and logo
  materials; plain colours, metalness and roughness given to materials the download leaves untextured (glass,
  carbon, chrome, calipers and others).
- Textures resized (at most 2048 px for the livery, 1024 px for the others) and re-encoded as WebP; geometry
  quantized and meshopt-compressed.
