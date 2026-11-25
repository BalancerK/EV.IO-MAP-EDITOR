// Editor document (game coordinates) -> .evmap structure (file coordinates), ready for writeEvmap.
//
// Game vs file space: the ev.io client mirrors every map on load (x *= -1; the scene root gets
// scale.x = -1), because maps are authored in Unity. So everything written here is mirrored in x:
//   positions and normals: x -> -x
//   triangles: the mirror flips handedness, so two indices are swapped to keep them
//              counter-clockwise around their normals in file space (measured on Bishop: 97,841
//              triangles agree with this, 61 don't)
//   spawn / teleporter yaw: the client converts with yaw = (270 - stored) degrees, so we store
//              270 - yaw
//   camera nodes: the client rebuilds the camera from the node's +z (forward) and +y (up)
//              axes after mirroring both in x
// Blocks are merged into a few big meshes (one per material + collision kind + shadow setting),
// as ev.io's own guide recommends: the object count, not the triangle count, is what costs frames.

import { buildBlockTriangles } from './geometry.js';
import { COLLISION } from './document.js';
import { NODE, MESH, LIGHT } from '../evmap/format.js';
import { docAsset, docBounds } from './assets.js';
import { modelFileTransform, mat3ToQuat } from './importer.js';

const MAX_TRIS_PER_MESH = 21000;   // the guide's per-object limit is 21,875 triangles

export function hexToRgb(hex) {
    const v = parseInt(String(hex).replace('#', ''), 16) || 0;
    return { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255 };
}

const mirror = (p) => ({ x: -p.x, y: p.y, z: p.z });
const deg = Math.PI / 180;

// Direction a directional light travels, in game space.
export function lightDirection(light) {
    const y = light.yaw * deg, p = light.pitch * deg;
    return { x: Math.sin(y) * Math.cos(p), y: -Math.sin(p), z: Math.cos(y) * Math.cos(p) };
}

// Camera forward for a yaw/pitch pair (three.js camera convention: yaw 0 looks down -z).
export function cameraForward(yawDeg, pitchDeg) {
    const y = yawDeg * deg, p = pitchDeg * deg;
    return { x: -Math.sin(y) * Math.cos(p), y: Math.sin(p), z: -Math.cos(y) * Math.cos(p) };
}

const norm = (v) => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

// Quaternion whose rotation maps +z to `f` and +y to `u` (both unit, orthogonal).
function quatFromBasis(f, u) {
    const x = cross(u, f);
    const m00 = x.x, m01 = u.x, m02 = f.x, m10 = x.y, m11 = u.y, m12 = f.y, m20 = x.z, m21 = u.z, m22 = f.z;
    const tr = m00 + m11 + m22;
    let qx, qy, qz, qw;
    if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); qw = 0.25 / s; qx = (m21 - m12) * s; qy = (m02 - m20) * s; qz = (m10 - m01) * s; }
    else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); qw = (m21 - m12) / s; qx = 0.25 * s; qy = (m01 + m10) / s; qz = (m02 + m20) / s; }
    else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); qw = (m02 - m20) / s; qx = (m01 + m10) / s; qy = 0.25 * s; qz = (m12 + m21) / s; }
    else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); qw = (m10 - m01) / s; qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = 0.25 * s; }
    return { x: qx, y: qy, z: qz, w: qw };
}

// File-space camera-node rotation for a game-space camera looking along yaw/pitch.
export function cameraNodeRotation(yawDeg, pitchDeg) {
    const f = norm(mirror(cameraForward(yawDeg, pitchDeg)));
    const worldUp = { x: 0, y: 1, z: 0 };
    let right = cross(worldUp, f);
    if (Math.hypot(right.x, right.y, right.z) < 1e-6) right = { x: 1, y: 0, z: 0 };
    const u = norm(cross(f, norm(right)));
    return quatFromBasis(f, u);
}

// The shadow camera the game builds for the shadow-casting light, in GAME space: it sits back along
// the light's direction from the map's centre and covers the whole map (the client uses
// shadowSettings.position, far, halfWidth and halfHeight exactly like this). Shared by the exporter
// and the editor's viewport so the preview's shadows fall where the game's will.
export function shadowSettingsFor(doc) {
    const caster0 = doc.lights.find((l) => l.castsShadow) || doc.lights[0];
    // An opened map keeps its own shadow camera (its authors tuned it to the map).
    if (doc.base && doc.base.shadow) {
        const s = doc.base.shadow;
        return { position: { ...s.position }, direction: caster0 ? lightDirection(caster0) : { x: 0, y: -1, z: 0 }, far: s.far, halfWidth: s.halfWidth, halfHeight: s.halfHeight };
    }
    const { min, max } = docBounds(doc) || { min: [0, 0, 0], max: [0, 0, 0] };
    const centre = { x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2, z: (min[2] + max[2]) / 2 };
    const radius = Math.max(10, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
    const caster = doc.lights.find((l) => l.castsShadow) || doc.lights[0];
    const direction = caster ? lightDirection(caster) : { x: 0, y: -1, z: 0 };
    const position = { x: centre.x - direction.x * radius * 1.5, y: centre.y - direction.y * radius * 1.5, z: centre.z - direction.z * radius * 1.5 };
    return { position, direction, centre, radius, far: radius * 3.5, halfWidth: radius, halfHeight: radius };
}

// Camera-path pose (position + yaw/pitch, the cameraForward convention) looking from `from` at `to`.
export function poseLookingAt(from, to) {
    const d = norm({ x: to.x - from.x, y: to.y - from.y, z: to.z - from.z });
    const r = (v) => Math.round(v * 1000) / 1000;
    const yaw = ((Math.atan2(-d.x, -d.z) / deg) % 360 + 360) % 360;
    const pitch = Math.asin(Math.max(-1, Math.min(1, d.y))) / deg;
    return { position: { x: r(from.x), y: r(from.y), z: r(from.z) }, yaw: r(yaw), pitch: r(pitch) };
}

// A starting set of menu-camera paths: `count` slow arcs circling the map, each looking at its
// centre from outside and above it (ev.io maps usually have about six). Returns new cameraPaths.
export function generateCameraPaths(doc, newId, count = 6, seconds = 25) {
    const { min, max } = docBounds(doc) || { min: [-30, 0, -30], max: [30, 10, 30] };
    const c = { x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2, z: (min[2] + max[2]) / 2 };
    const span = Math.max(max[0] - min[0], max[2] - min[2], 20);
    const distance = span * 0.75 + 8;
    const height = max[1] + span * 0.35 + 4;
    const look = { x: c.x, y: min[1] + (max[1] - min[1]) * 0.3, z: c.z };
    const sweep = (360 / count) * 0.6;
    const at = (a) => ({ x: c.x + Math.sin(a * deg) * distance, y: height, z: c.z + Math.cos(a * deg) * distance });
    const paths = [];
    for (let i = 0; i < count; i++) {
        const a = (360 / count) * i + 15;
        paths.push({ id: newId('cam'), start: poseLookingAt(at(a), look), end: poseLookingAt(at(a + sweep), look), seconds });
    }
    return paths;
}

// Merge blocks into meshes. Returns { meshes, nodes } in file space.
function buildMeshes(doc, materialIndex) {
    const groups = new Map();
    for (const block of doc.blocks) {
        const kind = block.collision || COLLISION.SOLID;
        const mat = kind === COLLISION.INVISIBLE ? -1 : (materialIndex.get(block.materialId) ?? 0);
        const shadows = kind !== COLLISION.INVISIBLE && block.shadows !== false;
        const key = `${mat}|${kind}|${shadows}`;
        if (!groups.has(key)) groups.set(key, { mat, kind, shadows, positions: [], normals: [] });
        const g = groups.get(key);
        const t = buildBlockTriangles(block);
        for (let i = 0; i < t.positions.length; i++) { g.positions.push(t.positions[i]); g.normals.push(t.normals[i]); }
    }

    const meshes = [], nodes = [];
    for (const g of groups.values()) {
        const triCount = g.positions.length / 9;
        for (let start = 0; start < triCount; start += MAX_TRIS_PER_MESH) {
            const end = Math.min(triCount, start + MAX_TRIS_PER_MESH);
            const verts = [], normals = [], index = [];
            const seen = new Map();   // dedupe identical (position, normal) corners
            const vertexOf = (i) => {
                const px = -g.positions[i * 3], py = g.positions[i * 3 + 1], pz = g.positions[i * 3 + 2];
                const nx = -g.normals[i * 3], ny = g.normals[i * 3 + 1], nz = g.normals[i * 3 + 2];
                const key = `${px.toFixed(4)},${py.toFixed(4)},${pz.toFixed(4)},${nx.toFixed(3)},${ny.toFixed(3)},${nz.toFixed(3)}`;
                let v = seen.get(key);
                if (v === undefined) { v = verts.length / 3; seen.set(key, v); verts.push(px, py, pz); normals.push(nx, ny, nz); }
                return v;
            };
            for (let tri = start; tri < end; tri++) {
                const a = vertexOf(tri * 3), b = vertexOf(tri * 3 + 1), c = vertexOf(tri * 3 + 2);
                index.push(a, c, b);   // swapped: the x mirror reversed the winding
            }
            if (!verts.length) continue;   // the client cannot read an empty vertex buffer
            const meshIndex = meshes.length;
            meshes.push({ features: MESH.NORMALS, vertexBuffer: Float32Array.from(verts), normalBuffer: Float32Array.from(normals), submeshes: [{ indexBuffer: Uint16Array.from(index) }] });
            let features = 0;
            if (g.kind !== COLLISION.INVISIBLE) features |= NODE.RENDER;
            if (g.kind !== COLLISION.VISUAL) features |= NODE.COLLISION;
            if (g.shadows) features |= NODE.SHADOWS;
            nodes.push({
                features,
                transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
                children: [],
                targetObjectIndex: meshIndex,
                materialIndices: g.kind !== COLLISION.INVISIBLE ? [Math.max(0, g.mat)] : undefined,
                collisionLayer: 1,
            });
        }
    }
    return { meshes, nodes };
}

// A sheared transform as two nodes: M = U diag(s) V^T (singular value decomposition), so a parent
// with rotation U and scale s holds a child with rotation V^T. Returns { u, s, vt } (row-major 3x3).
export function svd3(M) {
    // Eigenvectors of A = M^T M by Jacobi rotations.
    const A = [0, 1, 2].map((i) => [0, 1, 2].map((j) => M[i] * M[j] + M[3 + i] * M[3 + j] + M[6 + i] * M[6 + j]));
    const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 50; sweep++) {
        const off = Math.abs(A[0][1]) + Math.abs(A[0][2]) + Math.abs(A[1][2]);
        if (off < 1e-15) break;
        for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
            if (Math.abs(A[p][q]) < 1e-18) continue;
            const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
            const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const c = 1 / Math.sqrt(t * t + 1), sn = t * c;
            for (let k = 0; k < 3; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - sn * akq; A[k][q] = sn * akp + c * akq; }
            for (let k = 0; k < 3; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - sn * aqk; A[q][k] = sn * apk + c * aqk; }
            for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - sn * vkq; V[k][q] = sn * vkp + c * vkq; }
        }
    }
    const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if (det(V) < 0) for (let k = 0; k < 3; k++) V[k][2] = -V[k][2];
    const s = [0, 1, 2].map((j) => Math.sqrt(Math.max(0, A[j][j])));
    // U = M V diag(1/s)
    const U = [0, 1, 2].map((i) => [0, 1, 2].map((j) => (M[i * 3] * V[0][j] + M[i * 3 + 1] * V[1][j] + M[i * 3 + 2] * V[2][j]) / (s[j] || 1)));
    if (det(U) < 0) { for (let k = 0; k < 3; k++) U[k][0] = -U[k][0]; s[0] = -s[0]; }
    return { u: U.flat(), s, vt: [V[0][0], V[1][0], V[2][0], V[0][1], V[1][1], V[2][1], V[0][2], V[1][2], V[2][2]] };
}

const IDENTITY_Q = { x: 0, y: 0, z: 0, w: 1 };
// File-space node(s) for an imported model.
function modelNode(md, meshIndex) {
    let features = 0;
    if (md.render) features |= NODE.RENDER;
    if (md.collide) features |= NODE.COLLISION;
    if (md.shadows) features |= NODE.SHADOWS;
    const node = {
        features, name: (md.name || '').replace(/[^\x20-\x7e]/g, '').slice(0, 255), children: [],
        targetObjectIndex: meshIndex, materialIndices: md.render ? md.materials : undefined, collisionLayer: md.collisionLayer ?? 1,
    };
    if (!md.matrix) return { ...node, transform: modelFileTransform(md) };
    // Sheared: the file's world matrix W = S G S, written as a parent (U, s) and a child (V^T).
    const g = md.matrix;
    const W = g.m.slice();
    W[1] = -W[1]; W[2] = -W[2]; W[3] = -W[3]; W[6] = -W[6];
    const { u, s, vt } = svd3(W);
    node.transform = { position: { x: 0, y: 0, z: 0 }, rotation: mat3ToQuat(vt), scale: { x: 1, y: 1, z: 1 } };
    return {
        features: 0, children: [node],
        transform: { position: { x: -g.t[0], y: g.t[1], z: g.t[2] }, rotation: mat3ToQuat(u), scale: { x: s[0], y: s[1], z: s[2] } },
    };
}

// Weapon spawns added in the editor take the weapon list most of the map's spawns use.
function commonSpawnList(doc) {
    const counts = new Map();
    for (const w of doc.weaponSpawns) if (w.spawnList !== undefined) counts.set(w.spawnList, (counts.get(w.spawnList) || 0) + 1);
    let best = 0, n = 0;
    for (const [k, c] of counts) if (c > n) { best = k; n = c; }
    return best;
}

export function compileDocument(doc) {
    const asset = doc.base ? docAsset(doc) : null;
    if (doc.base && !asset) throw new Error('The original .evmap this map was opened from is not loaded. Open that file again, then export.');
    // Only materials that are used, in a stable order.
    const used = [...new Set(doc.blocks.filter((b) => b.collision !== COLLISION.INVISIBLE).map((b) => b.materialId))];
    const mats = used.map((id) => doc.materials.find((m) => m.id === id) || doc.materials[0]).filter(Boolean);
    if (!mats.length && !asset) mats.push({ color: '#9aa1a8', roughness: 0.8 });
    // An opened map's own materials come first, unchanged; the editor's follow.
    const baseMaterials = asset ? (asset.materialsEx || asset.materials) : [];
    const materialIndex = new Map(used.map((id, i) => [id, i + baseMaterials.length]));
    const materials = mats.map((m) => ({
        color: hexToRgb(m.color), colorAlpha: m.opacity ?? 1,
        metallic: m.metallic ?? 0.25, roughness: m.roughness ?? 0.5,
        ...(m.emissive && m.emissive !== '#000000' ? { emissionColor: hexToRgb(m.emissive), emissionIntensity: m.emissiveIntensity ?? 1 } : {}),
    }));

    // The opened map's meshes (only those still used), written back byte-for-byte; then the blocks.
    const meshes = [], nodes = [];
    if (asset) {
        const meshMap = new Map();
        for (const md of doc.models || []) {
            if (!md.render && !md.collide) continue;
            if (!asset.meshes[md.mesh]) continue;
            if (!meshMap.has(md.mesh)) { meshMap.set(md.mesh, meshes.length); meshes.push(asset.meshes[md.mesh]); }
            nodes.push(modelNode(md, meshMap.get(md.mesh)));
        }
    }
    const built = buildMeshes(doc, materialIndex);
    for (const n of built.nodes) n.targetObjectIndex += meshes.length;
    meshes.push(...built.meshes);
    nodes.push(...built.nodes);
    if (!meshes.length) throw new Error('The map has no geometry. Add at least one block.');

    const env = doc.environment;
    const lights = doc.lights.length ? doc.lights : [];
    const shadow = shadowSettingsFor(doc);

    const idx = (list) => new Map(list.map((it, i) => [it.id, i]));
    const teleIndex = idx(doc.teleporters);
    const navIndex = idx(doc.navNodes);

    let shadowSeen = false;
    const out = {
        meshes,
        textures: asset ? asset.textures : [],
        ...(asset && asset.materialsEx
            ? { materialsEx: [...asset.materialsEx, ...materials.map((material) => ({ shader: 0, material }))] }
            : { materials: [...baseMaterials, ...materials] }),
        rootObject: { features: 0, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } }, children: nodes },
        ...(doc.base || doc.weaponSpawns.some((w) => w.spawnList !== undefined)
            ? { weaponSpawnsEx: doc.weaponSpawns.map((w) => ({ features: 0, position: mirror(w.position), spawnList: w.spawnList ?? commonSpawnList(doc) })) }
            : { weaponSpawns: doc.weaponSpawns.map((w) => mirror(w.position)) }),
        playerSpawns: doc.playerSpawns.map((s) => ({
            position: { ...mirror(s.position), w: 270 - (s.yaw || 0) },
            neutral: s.team === 'neutral' || !s.team, team1: s.team === 'team1', team2: s.team === 'team2',
        })),
        directionalLights: lights.map((l) => {
            const castsShadow = !!l.castsShadow && !shadowSeen;
            if (castsShadow) shadowSeen = true;
            return {
                direction: mirror(lightDirection(l)), color: hexToRgb(l.color), intensity: l.intensity,
                features: (castsShadow ? LIGHT.CASTS_SHADOW : 0) | LIGHT.SHADOW_STRENGTH,
                shadowStrength: env.shadowStrength ?? 0.75,
            };
        }),
        shadowSettings: { position: mirror(shadow.position), far: shadow.far, halfWidth: shadow.halfWidth, halfHeight: shadow.halfHeight },
        gradientSkybox: { features: 0, bottom: hexToRgb(env.skyBottom), horizon: hexToRgb(env.skyHorizon), top: hexToRgb(env.skyTop) },
        fogColor: hexToRgb(env.fogColor),
        fogDensity: Math.max(0, env.fogDensity ?? 0),
        hemisphereSkyColor: hexToRgb(env.hemiSky),
        hemisphereGroundColor: hexToRgb(env.hemiGround),
        hemisphereIntensity: env.hemiIntensity ?? 0.3,
        cameraPaths: doc.cameraPaths.map((c) => ({
            nodes: [
                { position: mirror(c.start.position), rotation: cameraNodeRotation(c.start.yaw, c.start.pitch), secsToNextNode: Math.max(1, c.seconds || 20) },
                { position: mirror(c.end.position), rotation: cameraNodeRotation(c.end.yaw, c.end.pitch), secsToNextNode: -1 },
            ],
        })),
        aiNavNodes: doc.navNodes.map((n) => ({ position: mirror(n.position), neighborIndices: (n.links || []).map((id) => navIndex.get(id)).filter((i) => i !== undefined), layer: n.layer || '' })),
        teleporters: doc.teleporters.map((t) => ({
            position: mirror(t.position), rotation: 270 - (t.yaw || 0), radius: t.radius || 1.5,
            destinationIndices: (t.destinations || []).map((id) => teleIndex.get(id)).filter((i) => i !== undefined), gameMode: t.gameMode || '',
        })),
        flagSpawns: doc.base ? doc.base.flagSpawns : [],
        bombSites: doc.base ? doc.base.bombSites : [],
        battleRoyaleCircle: doc.brCircle ? { ...mirror(doc.brCircle.position), w: doc.brCircle.radius } : undefined,
        cameraFarPlane: env.farPlane || 1000,
    };
    return out;
}
