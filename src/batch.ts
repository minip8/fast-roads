import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ============================================================================
// Static geometry batching: many small parts merged into one mesh per material, so a grandstand or a row of
// boards costs a couple of draw calls instead of dozens.
// ============================================================================
export class Batch {
  private readonly parts = new Map<THREE.Material, THREE.BufferGeometry[]>();

  // Adds geo, transformed by m, to the batch for `mat`. With an array of materials, geo's groups pick the material
  // (as for a multi-material mesh, e.g. a BoxGeometry's six faces).
  add(geo: THREE.BufferGeometry, m: THREE.Matrix4, mat: THREE.Material | THREE.Material[]) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    g.applyMatrix4(m);
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    if (!Array.isArray(mat)) { this.push(mat, g); return; }
    for (const grp of geo.groups) {
      const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
      const sub = new THREE.BufferGeometry(), a = grp.start, n = grp.count;
      sub.setAttribute('position', new THREE.BufferAttribute((pos.array as Float32Array).slice(a * 3, (a + n) * 3), 3));
      sub.setAttribute('normal', new THREE.BufferAttribute((nor.array as Float32Array).slice(a * 3, (a + n) * 3), 3));
      sub.setAttribute('uv', new THREE.BufferAttribute((uv.array as Float32Array).slice(a * 2, (a + n) * 2), 2));
      this.push(mat[grp.materialIndex ?? 0], sub);
    }
  }
  private push(mat: THREE.Material, g: THREE.BufferGeometry) {
    let list = this.parts.get(mat);
    if (!list) this.parts.set(mat, (list = []));
    list.push(g);
  }
  // One mesh per material, added to `parent`.
  build(parent: THREE.Object3D, { castShadow = true, receiveShadow = true } = {}) {
    const meshes: THREE.Mesh[] = [];
    for (const [mat, list] of this.parts) {
      const mesh = new THREE.Mesh(mergeGeometries(list), mat);
      mesh.castShadow = castShadow; mesh.receiveShadow = receiveShadow;
      parent.add(mesh); meshes.push(mesh);
      for (const g of list) g.dispose();
    }
    this.parts.clear();
    return meshes;
  }
}
