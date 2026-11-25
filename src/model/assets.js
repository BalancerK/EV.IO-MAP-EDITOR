// The geometry behind imported models. A document opened from an .evmap keeps that file as its BASE
// (doc.base.key); the parsed file is registered here, so the exporter, the walk test, Auto nav and
// the viewport can reach its meshes. Pure JavaScript (no three.js).
import { buildBlockTriangles } from './geometry.js';
import { COLLISION } from './document.js';
import { modelAffine, modelCollides } from './importer.js';

const store = new Map();
export function registerAsset(key, evmap) { store.set(key, evmap); }
export const getAsset = (key) => store.get(key) || null;
export const docAsset = (doc) => (doc && doc.base ? getAsset(doc.base.key) : null);

/** Game-space transform of a model, applied to its MIRRORED mesh (x negated). */
export const modelTransform = (model) => model.matrix || modelAffine(model);

const det3 = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);

/**
 * World-space triangles of a model as a flat array (9 numbers per triangle), counter-clockwise seen
 * from the front in game space. Mirroring the mesh reverses its winding, and so does a transform
 * with a negative scale; each reversal is undone.
 */
export function modelTriangles(model, asset, out = []) {
    const mesh = asset && asset.meshes[model.mesh];
    if (!mesh) return out;
    const { m, t } = modelTransform(model);
    const v = mesh.vertexBuffer;
    const flip = det3(m) < 0;   // the mirror flips once; a negative-scale transform flips back
    for (const sub of mesh.submeshes) {
        const ib = sub.indexBuffer;
        for (let i = 0; i + 2 < ib.length; i += 3) {
            const order = flip ? [ib[i], ib[i + 1], ib[i + 2]] : [ib[i], ib[i + 2], ib[i + 1]];
            for (const k of order) {
                const x = -v[k * 3], y = v[k * 3 + 1], z = v[k * 3 + 2];
                out.push(m[0] * x + m[1] * y + m[2] * z + t[0], m[3] * x + m[4] * y + m[5] * z + t[1], m[6] * x + m[7] * y + m[8] * z + t[2]);
            }
        }
    }
    return out;
}

// File-space bounds of each mesh, cached on the parsed mesh.
function meshBox(mesh) {
    if (mesh._box) return mesh._box;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const v = mesh.vertexBuffer;
    for (let i = 0; i < v.length; i++) { const a = i % 3; if (v[i] < min[a]) min[a] = v[i]; if (v[i] > max[a]) max[a] = v[i]; }
    mesh._box = { min, max };
    return mesh._box;
}
/** Axis-aligned game-space bounds of a model ({ min, max } arrays), or null. */
export function modelBounds(model, asset) {
    const mesh = asset && asset.meshes[model.mesh];
    if (!mesh || !mesh.vertexBuffer.length) return null;
    const b = meshBox(mesh);
    const { m, t } = modelTransform(model);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
        const x = -(c & 1 ? b.max[0] : b.min[0]), y = c & 2 ? b.max[1] : b.min[1], z = c & 4 ? b.max[2] : b.min[2];
        const p = [m[0] * x + m[1] * y + m[2] * z + t[0], m[3] * x + m[4] * y + m[5] * z + t[1], m[6] * x + m[7] * y + m[8] * z + t[2]];
        for (let a = 0; a < 3; a++) { if (p[a] < min[a]) min[a] = p[a]; if (p[a] > max[a]) max[a] = p[a]; }
    }
    return { min, max };
}

/** Bounds of everything in the map (blocks and models), or null when it is empty. */
export function docBounds(doc) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const grow = (p) => { for (let a = 0; a < 3; a++) { if (p[a] < min[a]) min[a] = p[a]; if (p[a] > max[a]) max[a] = p[a]; } };
    for (const b of doc.blocks) {
        const { positions } = buildBlockTriangles(b);
        for (let i = 0; i < positions.length; i += 3) grow([positions[i], positions[i + 1], positions[i + 2]]);
    }
    const asset = docAsset(doc);
    for (const md of doc.models || []) { const bb = modelBounds(md, asset); if (bb) { grow(bb.min); grow(bb.max); } }
    return min[0] === Infinity ? null : { min, max };
}

/**
 * Everything a player collides with, as one Float32Array of triangles (9 numbers each, game space,
 * counter-clockwise from the front): solid blocks, invisible walls, and models the game would
 * collide with. Decoration and models without player collision are left out.
 */
export function collisionTriangles(doc) {
    const out = [];
    for (const b of doc.blocks) {
        if (b.collision === COLLISION.VISUAL) continue;
        const { positions } = buildBlockTriangles(b);
        for (let i = 0; i < positions.length; i++) out.push(positions[i]);
    }
    const asset = docAsset(doc);
    if (asset) for (const md of doc.models || []) if (modelCollides(md)) modelTriangles(md, asset, out);
    return Float32Array.from(out);
}
