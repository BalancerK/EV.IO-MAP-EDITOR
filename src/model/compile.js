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

import { buildBlockTriangles, blocksBounds } from './geometry.js';
import { COLLISION } from './document.js';
import { NODE, MESH, LIGHT } from '../evmap/format.js';

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

export function compileDocument(doc) {
    // Only materials that are used, in a stable order.
    const used = [...new Set(doc.blocks.filter((b) => b.collision !== COLLISION.INVISIBLE).map((b) => b.materialId))];
    const mats = used.map((id) => doc.materials.find((m) => m.id === id) || doc.materials[0]).filter(Boolean);
    if (!mats.length) mats.push({ color: '#9aa1a8', roughness: 0.8 });
    const materialIndex = new Map(used.map((id, i) => [id, i]));
    const materials = mats.map((m) => ({
        color: hexToRgb(m.color), colorAlpha: m.opacity ?? 1,
        metallic: m.metallic ?? 0.25, roughness: m.roughness ?? 0.5,
        ...(m.emissive && m.emissive !== '#000000' ? { emissionColor: hexToRgb(m.emissive), emissionIntensity: m.emissiveIntensity ?? 1 } : {}),
    }));

    const { meshes, nodes } = buildMeshes(doc, materialIndex);
    if (!meshes.length) throw new Error('The map has no geometry. Add at least one block.');

    const env = doc.environment;
    const { min, max } = blocksBounds(doc.blocks);
    const centre = { x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2, z: (min[2] + max[2]) / 2 };
    const radius = Math.max(10, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);

    const lights = doc.lights.length ? doc.lights : [];
    const caster = lights.find((l) => l.castsShadow) || lights[0];
    const casterDir = caster ? lightDirection(caster) : { x: 0, y: -1, z: 0 };
    const shadowPos = { x: centre.x - casterDir.x * radius * 1.5, y: centre.y - casterDir.y * radius * 1.5, z: centre.z - casterDir.z * radius * 1.5 };

    const idx = (list) => new Map(list.map((it, i) => [it.id, i]));
    const teleIndex = idx(doc.teleporters);
    const navIndex = idx(doc.navNodes);

    let shadowSeen = false;
    const out = {
        meshes,
        textures: [],
        materials,
        rootObject: { features: 0, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } }, children: nodes },
        weaponSpawns: doc.weaponSpawns.map((w) => mirror(w.position)),
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
        shadowSettings: { position: mirror(shadowPos), far: radius * 3.5, halfWidth: radius, halfHeight: radius },
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
        aiNavNodes: doc.navNodes.map((n) => ({ position: mirror(n.position), neighborIndices: (n.links || []).map((id) => navIndex.get(id)).filter((i) => i !== undefined), layer: '' })),
        teleporters: doc.teleporters.map((t) => ({
            position: mirror(t.position), rotation: 270 - (t.yaw || 0), radius: t.radius || 1.5,
            destinationIndices: (t.destinations || []).map((id) => teleIndex.get(id)).filter((i) => i !== undefined), gameMode: '',
        })),
        battleRoyaleCircle: doc.brCircle ? { ...mirror(doc.brCircle.position), w: doc.brCircle.radius } : undefined,
        cameraFarPlane: env.farPlane || 1000,
    };
    return out;
}
