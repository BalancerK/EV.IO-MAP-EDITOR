// .evmap -> glTF 2.0 (.gltf with the data embedded, or binary .glb), for Blender, three.js editor and other 3D tools.
// Pure JavaScript (no three.js), so it runs in the editor and in Node tests.
//
// Input is the structure readEvmap returns (or compileDocument, which has the same shape), so a
// map opened from a file and a map built in the editor convert the same way.
//
// Everything is written in GAME space, the way players see the map: the client mirrors the whole
// file in x on load (maps were authored in Unity), so
//   vertices and normals  x -> -x, and each triangle's winding flipped to stay counter-clockwise
//   node transforms       G = S W S for the file's world matrix W (S = mirror x)
//   texture v             v -> 1 - v (glTF's uv origin is the top-left corner)
// Colours are stored as the game uses them (it writes them to the screen as-is); glTF colour
// factors are linear, so they are converted from sRGB, which makes viewers show the same colours.
//
// What goes in: every rendered piece with its materials and textures, the sun lights
// (KHR_lights_punctual), and empty nodes marking player spawns, weapon spawns and teleporters.
// Collision-only pieces (invisible walls) are left out unless `includeCollision` is set; then they
// come in a separate "Invisible collision" group with a faint red material.
// Not carried: lightmaps, light probes, the sky, fog and nav nodes (the scene's `extras` keep the
// sky and fog colours).

import { NODE } from './format.js';

const S = [-1, 1, 1];
const FLOAT = 5126, USHORT = 5123, UINT = 5125;
const ARRAY_BUFFER = 34962, ELEMENT_ARRAY_BUFFER = 34963;

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lin3 = (c) => [toLinear(clamp01(c.r)), toLinear(clamp01(c.g)), toLinear(clamp01(c.b))];

function quatToMat3({ x, y, z, w }) {
    return [
        1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
        2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
        2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
    ];
}
function trs(t) {
    const q = t.rotation, len = Math.hypot(q.x, q.y, q.z, q.w) || 1;
    const r = quatToMat3({ x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len });
    const s = t.scale, p = t.position;
    return { m: [r[0] * s.x, r[1] * s.y, r[2] * s.z, r[3] * s.x, r[4] * s.y, r[5] * s.z, r[6] * s.x, r[7] * s.y, r[8] * s.z], t: [p.x, p.y, p.z] };
}
function mul(a, b) {
    const m = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j] = a.m[i * 3] * b.m[j] + a.m[i * 3 + 1] * b.m[3 + j] + a.m[i * 3 + 2] * b.m[6 + j];
    const t = [0, 1, 2].map((i) => a.m[i * 3] * b.t[0] + a.m[i * 3 + 1] * b.t[1] + a.m[i * 3 + 2] * b.t[2] + a.t[i]);
    return { m, t };
}
// File world matrix -> game space (S W S), as a glTF column-major 4x4.
function gameMatrix(w) {
    const out = new Array(16).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[j * 4 + i] = S[i] * S[j] * w.m[i * 3 + j];
    for (let i = 0; i < 3; i++) out[12 + i] = S[i] * w.t[i];
    out[15] = 1;
    return out;
}
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const isIdentity = (m) => m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-9);

// The rotation that turns -z (where a glTF directional light points) onto unit vector d.
function quatFromMinusZ(d) {
    const len = Math.hypot(d.x, d.y, d.z) || 1;
    const x = d.x / len, y = d.y / len, z = d.z / len;
    const dot = -z;                                   // (0,0,-1) . d
    if (dot < -0.999999) return [0, 1, 0, 0];         // opposite: half a turn about y
    // axis = (0,0,-1) x d = (y, -x, 0)
    const q = [y, -x, 0, 1 + dot];
    const n = Math.hypot(...q);
    return q.map((v) => v / n);
}

class BinChunk {
    constructor() { this.parts = []; this.length = 0; this.views = []; }
    // Adds bytes on a 4-byte boundary and returns the bufferView index.
    add(bytes, target) {
        const pad = (4 - (this.length % 4)) % 4;
        if (pad) { this.parts.push(new Uint8Array(pad)); this.length += pad; }
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const view = { buffer: 0, byteOffset: this.length, byteLength: u8.byteLength };
        if (target) view.target = target;
        this.parts.push(u8); this.length += u8.byteLength;
        this.views.push(view);
        return this.views.length - 1;
    }
    bytes() {
        const total = this.length + ((4 - (this.length % 4)) % 4);
        const out = new Uint8Array(total);
        let o = 0;
        for (const p of this.parts) { out.set(p, o); o += p.byteLength; }
        return out;
    }
}

export function evmapToGltf(m, opts = {}) {
    const includeCollision = !!opts.includeCollision;
    const bin = new BinChunk();
    const json = {
        asset: { version: '2.0', generator: 'EV.IO Map Editor (evmap -> glTF)' },
        scene: 0, scenes: [{ name: opts.name || 'ev.io map', nodes: [] }],
        nodes: [], meshes: [], accessors: [], materials: [], textures: [], images: [], samplers: [],
        bufferViews: bin.views, buffers: [],
    };
    const used = new Set();
    const root = json.scenes[0].nodes;
    const accessor = (a) => { json.accessors.push(a); return json.accessors.length - 1; };
    const addNode = (n, parent) => { json.nodes.push(n); const i = json.nodes.length - 1; (parent ? (parent.children ||= []) : root).push(i); return i; };

    // ---------------------------------------------------------------- textures
    const imageIndex = new Map();
    const textureIndex = (i) => {
        if (i === undefined || i === null || i < 0 || !m.textures || !m.textures[i]) return undefined;
        if (imageIndex.has(i)) return imageIndex.get(i);
        if (!json.samplers.length) json.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 });
        const t = m.textures[i];
        json.images.push({ bufferView: bin.add(t.data), mimeType: t.format === 1 ? 'image/jpeg' : 'image/png' });
        json.textures.push({ sampler: 0, source: json.images.length - 1 });
        imageIndex.set(i, json.textures.length - 1);
        return json.textures.length - 1;
    };
    // Unity's (scale x, scale y, offset x, offset y), re-expressed for flipped v.
    const texRef = (i, so) => {
        const index = textureIndex(i);
        if (index === undefined) return undefined;
        const ref = { index };
        if (so && (so.x !== 1 || so.y !== 1 || so.z !== 0 || so.w !== 0)) {
            ref.extensions = { KHR_texture_transform: { scale: [so.x, so.y], offset: [so.z, 1 - so.y - so.w] } };
            used.add('KHR_texture_transform');
        }
        return ref;
    };

    // ---------------------------------------------------------------- materials
    const list = m.materialsEx || (m.materials || []).map((material) => ({ shader: 0, material }));
    const materialIndex = new Map();
    const material = (i) => {
        if (materialIndex.has(i)) return materialIndex.get(i);
        const e = list[i];
        const mat = e ? buildMaterial(e, i) : { name: `material ${i}`, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } };
        json.materials.push(mat);
        materialIndex.set(i, json.materials.length - 1);
        return json.materials.length - 1;
    };
    function buildMaterial(e, i) {
        const mm = e.material || {};
        const name = `material ${i}`;
        if (e.shader === 0) {
            const a = mm.colorAlpha ?? 1;
            // The game draws these toon-shaded, not physically based: metalness is left at 0 so the
            // map does not render dark in viewers without an environment map.
            const pbr = { baseColorFactor: [...lin3(mm.color || { r: 1, g: 1, b: 1 }), a], metallicFactor: 0, roughnessFactor: mm.roughness ?? 1 };
            const so = mm.uvScaleOffset;
            const base = texRef(mm.colorMapIndex, so);
            if (base) pbr.baseColorTexture = base;
            const out = { name, pbrMetallicRoughness: pbr };
            if (a < 0.99) out.alphaMode = 'BLEND';
            if (mm.emissionColor) {
                const k = mm.emissionIntensity ?? 1;
                const c = lin3(mm.emissionColor);
                const peak = Math.max(...c) * k;
                out.emissiveFactor = peak > 1 ? c.map((v) => (v * k) / peak) : c.map((v) => v * k);
                if (peak > 1) { out.extensions = { KHR_materials_emissive_strength: { emissiveStrength: peak } }; used.add('KHR_materials_emissive_strength'); }
                const em = texRef(mm.emissionMapIndex, so);
                if (em) out.emissiveTexture = em;
            }
            const nm = texRef(mm.normalMapIndex, so);
            if (nm) out.normalTexture = nm;
            const oc = texRef(mm.occlusionMapIndex, so);
            if (oc) out.occlusionTexture = { ...oc, strength: mm.occlusionMultiplier ?? 1 };
            return out;
        }
        // Shaders 1 (toon) and 2 (unlit colour) draw as flat colour in game; 3 is a billboard.
        used.add('KHR_materials_unlit');
        const c = mm.color ? lin3(mm.color) : [1, 1, 1];
        const pbr = { baseColorFactor: [...c, 1], metallicFactor: 0, roughnessFactor: 1 };
        if (e.shader === 1) { const t = texRef(mm.mainTextureIndex); if (t) pbr.baseColorTexture = t; }
        return { name: `${name} (${['', 'toon', 'unlit', 'billboard'][e.shader] || 'shader ' + e.shader})`, pbrMetallicRoughness: pbr, extensions: { KHR_materials_unlit: {} } };
    }
    let collisionMaterial = null;
    const invisibleMaterial = () => {
        if (collisionMaterial === null) {
            json.materials.push({ name: 'invisible collision', alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [1, 0.1, 0.1, 0.15], metallicFactor: 0, roughnessFactor: 1 } });
            collisionMaterial = json.materials.length - 1;
        }
        return collisionMaterial;
    };

    // ---------------------------------------------------------------- geometry (shared per mesh)
    const geometry = new Map();
    const meshGeometry = (mi) => {
        if (geometry.has(mi)) return geometry.get(mi);
        const mesh = m.meshes[mi];
        const v = Float32Array.from(mesh.vertexBuffer);
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < v.length; i += 3) {
            v[i] = -v[i];
            for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], v[i + k]); max[k] = Math.max(max[k], v[i + k]); }
        }
        const count = v.length / 3;
        const attributes = { POSITION: accessor({ bufferView: bin.add(v, ARRAY_BUFFER), componentType: FLOAT, count, type: 'VEC3', min, max }) };
        if (mesh.normalBuffer && mesh.normalBuffer.length === v.length) {
            const n = Float32Array.from(mesh.normalBuffer);
            for (let i = 0; i < n.length; i += 3) {
                n[i] = -n[i];
                const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
                if (l > 0) { n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; } else n[i + 1] = 1;
            }
            attributes.NORMAL = accessor({ bufferView: bin.add(n, ARRAY_BUFFER), componentType: FLOAT, count, type: 'VEC3' });
        }
        if (mesh.uvBuffer && mesh.uvBuffer.length === count * 2) {
            const uv = Float32Array.from(mesh.uvBuffer);
            for (let i = 1; i < uv.length; i += 2) uv[i] = 1 - uv[i];
            attributes.TEXCOORD_0 = accessor({ bufferView: bin.add(uv, ARRAY_BUFFER), componentType: FLOAT, count, type: 'VEC2' });
        }
        const indices = mesh.submeshes.map((sm) => {
            const ib = sm.indexBuffer;
            const n = ib.length - (ib.length % 3);
            if (!n) return null;
            const out = count > 65535 ? new Uint32Array(n) : new Uint16Array(n);
            for (let i = 0; i < n; i += 3) { out[i] = ib[i]; out[i + 1] = ib[i + 2]; out[i + 2] = ib[i + 1]; }
            return accessor({ bufferView: bin.add(out, ELEMENT_ARRAY_BUFFER), componentType: count > 65535 ? UINT : USHORT, count: n, type: 'SCALAR' });
        });
        const g = { attributes, indices };
        geometry.set(mi, g);
        return g;
    };
    const meshFor = new Map();
    const gltfMesh = (mi, mats, collisionOnly) => {
        const key = collisionOnly ? `${mi}|c` : `${mi}|${(mats || []).join(',')}`;
        if (meshFor.has(key)) return meshFor.get(key);
        const g = meshGeometry(mi);
        const primitives = [];
        g.indices.forEach((ind, h) => {
            if (ind === null) return;
            const matIdx = collisionOnly ? invisibleMaterial() : material(mats && mats.length ? (mats[Math.min(h, mats.length - 1)] ?? 0) : 0);
            primitives.push({ attributes: g.attributes, indices: ind, material: matIdx, mode: 4 });
        });
        const idx = primitives.length ? (json.meshes.push({ name: `mesh ${mi}`, primitives }), json.meshes.length - 1) : null;
        meshFor.set(key, idx);
        return idx;
    };

    // ---------------------------------------------------------------- scene tree (flattened)
    const geometryGroup = { name: 'Map', children: [] };
    addNode(geometryGroup);
    let collisionGroup = null;
    let pieces = 0, collisionPieces = 0;
    const walk = (n, parentWorld) => {
        const world = mul(parentWorld, trs(n.transform));
        const mi = n.targetObjectIndex;
        const mesh = mi !== undefined && m.meshes[mi] && m.meshes[mi].vertexBuffer && m.meshes[mi].vertexBuffer.length ? m.meshes[mi] : null;
        const render = !!(n.features & NODE.RENDER), collide = !!(n.features & NODE.COLLISION);
        if (mesh && (render || (collide && includeCollision))) {
            const meshIndex = gltfMesh(mi, n.materialIndices, !render);
            if (meshIndex !== null) {
                const node = { name: n.name || `piece ${pieces + collisionPieces}`, mesh: meshIndex };
                const mat = gameMatrix(world);
                if (!isIdentity(mat)) node.matrix = mat;
                if (render) { addNode(node, geometryGroup); pieces++; }
                else {
                    if (!collisionGroup) { collisionGroup = { name: 'Invisible collision', children: [] }; addNode(collisionGroup); }
                    addNode(node, collisionGroup); collisionPieces++;
                }
            }
        }
        for (const c of n.children || []) walk(c, world);
    };
    walk(m.rootObject, { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });

    // ---------------------------------------------------------------- lights
    const lights = (m.directionalLights || []).filter((l) => l && l.direction);
    if (lights.length) {
        used.add('KHR_lights_punctual');
        json.extensions = { KHR_lights_punctual: { lights: lights.map((l, i) => ({ name: `sun ${i + 1}`, type: 'directional', color: lin3(l.color), intensity: l.intensity ?? 1 })) } };
        const group = { name: 'Lights', children: [] };
        addNode(group);
        lights.forEach((l, i) => addNode({
            name: `sun ${i + 1}`, rotation: quatFromMinusZ({ x: -l.direction.x, y: l.direction.y, z: l.direction.z }),
            extensions: { KHR_lights_punctual: { light: i } },
        }, group));
    }

    // ---------------------------------------------------------------- gameplay markers (empties)
    const at = (p) => [-p.x, p.y, p.z];
    const markers = (name, items, make) => {
        if (!items || !items.length) return;
        const group = { name, children: [] };
        addNode(group);
        items.forEach((it, i) => addNode(make(it, i), group));
    };
    markers('Player spawns', m.playerSpawns, (s, i) => ({
        name: `spawn ${i + 1}${s.team1 ? ' team 1' : s.team2 ? ' team 2' : ''}`, translation: at(s.position),
        extras: { yaw: 270 - s.position.w, neutral: !!s.neutral, team1: !!s.team1, team2: !!s.team2 },
    }));
    markers('Weapon spawns', m.weaponSpawnsEx || m.weaponSpawns, (w, i) => ({
        name: `weapon spawn ${i + 1}`, translation: at(w.position || w), ...(w.spawnList !== undefined ? { extras: { spawnList: w.spawnList } } : {}),
    }));
    markers('Teleporters', m.teleporters, (t, i) => ({
        name: `teleporter ${i + 1}`, translation: at(t.position),
        extras: { yaw: 270 - t.rotation, radius: t.radius, destinations: (t.destinationIndices || []).map((d) => d + 1), gameMode: t.gameMode || '' },
    }));

    const hex = (c) => c && '#' + [c.r, c.g, c.b].map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('');
    json.scenes[0].extras = {
        source: 'ev.io .evmap (game space: the file mirrored in x, as the client loads it)',
        fogColor: hex(m.fogColor), fogDensity: m.fogDensity,
        ...(m.gradientSkybox ? { skyBottom: hex(m.gradientSkybox.bottom), skyHorizon: hex(m.gradientSkybox.horizon), skyTop: hex(m.gradientSkybox.top) } : {}),
    };

    if (used.size) json.extensionsUsed = [...used];
    for (const k of ['meshes', 'accessors', 'materials', 'textures', 'images', 'samplers']) if (!json[k].length) delete json[k];
    const binary = bin.bytes();
    if (binary.length) json.buffers.push({ byteLength: binary.length }); else { delete json.buffers; delete json.bufferViews; }
    return { json, binary, stats: { pieces, collisionPieces, meshes: json.meshes ? json.meshes.length : 0, materials: json.materials ? json.materials.length : 0, textures: json.images ? json.images.length : 0 } };
}

// Packs glTF JSON + binary into one .glb file.
export function packGlb(json, binary) {
    const enc = new TextEncoder();
    let jsonBytes = enc.encode(JSON.stringify(json));
    const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
    if (jsonPad) { const p = new Uint8Array(jsonBytes.length + jsonPad).fill(0x20); p.set(jsonBytes); jsonBytes = p; }
    const hasBin = binary && binary.length;
    const total = 12 + 8 + jsonBytes.length + (hasBin ? 8 + binary.length : 0);
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
    dv.setUint32(12, jsonBytes.length, true); dv.setUint32(16, 0x4e4f534a, true);
    out.set(jsonBytes, 20);
    if (hasBin) {
        const o = 20 + jsonBytes.length;
        dv.setUint32(o, binary.length, true); dv.setUint32(o + 4, 0x004e4942, true);
        out.set(binary, o + 8);
    }
    return out;
}

// A single self-contained .gltf (JSON text): the binary buffer is embedded as a base64 data URI.
function base64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
    let out = '';
    for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(out);
}
export function packGltf(json, binary) {
    const doc = { ...json };
    if (binary && binary.length) doc.buffers = [{ byteLength: binary.length, uri: 'data:application/octet-stream;base64,' + base64(binary) }];
    return new TextEncoder().encode(JSON.stringify(doc));
}
export function evmapToGltfFile(m, opts = {}) {
    const { json, binary, stats } = evmapToGltf(m, opts);
    return { bytes: packGltf(json, binary), stats };
}

export function evmapToGlb(m, opts = {}) {
    const { json, binary, stats } = evmapToGltf(m, opts);
    return { bytes: packGlb(json, binary), stats };
}
