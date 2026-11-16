// Prints a glTF file's scene graph (node names, transforms, world bounds, triangle counts, materials) and its
// materials and textures: what convert.mjs needs to know about a source model (or how a converted one came out).
//   node scripts/cars/inspect.mjs <file.glb>
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(process.argv[2]);
const root = doc.getRoot();
const fmt = (a) => a.map((v) => +v.toFixed(3)).join(',');
const tris = (mesh) => mesh.listPrimitives().reduce((a, p) => a + (p.getIndices() ?? p.getAttribute('POSITION')).getCount() / 3, 0);
let total = 0;
function walk(node, depth) {
  const m = node.getMesh();
  let line = '  '.repeat(depth) + JSON.stringify(node.getName());
  if (m) {
    const b = getBounds(node), n = tris(m);
    total += n;
    line += ` [${n} tris; ${m.listPrimitives().map((p) => p.getMaterial()?.getName()).join(' | ')}] min=${fmt(b.min)} max=${fmt(b.max)}`;
  }
  line += ` T=${fmt(node.getTranslation())} R=${fmt(node.getRotation())} S=${fmt(node.getScale())}`;
  console.log(line);
  for (const c of node.listChildren()) walk(c, depth + 1);
}
console.log('extensions:', root.listExtensionsUsed().map((e) => e.extensionName).join(', '));
for (const sc of root.listScenes()) for (const n of sc.listChildren()) walk(n, 0);
console.log('triangles:', total);
console.log('materials:');
for (const m of root.listMaterials()) {
  console.log(' ', JSON.stringify(m.getName()), 'base', fmt(m.getBaseColorFactor()), 'tex', m.getBaseColorTexture()?.getName() ?? '-',
    'normal', m.getNormalTexture()?.getName() ?? '-', 'mr', m.getMetallicRoughnessTexture()?.getName() ?? '-',
    'alpha', m.getAlphaMode(), 'metal', m.getMetallicFactor(), 'rough', m.getRoughnessFactor(), 'emissive', fmt(m.getEmissiveFactor()),
    'exts', m.listExtensions().map((e) => e.extensionName).join(','));
}
console.log('textures:');
for (const t of root.listTextures()) console.log(' ', JSON.stringify(t.getName()), t.getMimeType(), t.getSize()?.join('x'), (t.getImage().byteLength / 1e6).toFixed(2) + ' MB');
