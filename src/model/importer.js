// Opening an existing .evmap: turns the file's structure (readEvmap) into an editor document.
// Pure JavaScript (no three.js), so it runs in the editor and in Node tests.
//
// The map's own geometry becomes MODELS: one per mesh-carrying piece of its scene tree, with the
// tree flattened to a world transform each. Their meshes, materials and textures are not copied into
// the document (they can be tens of MB); they stay in the original file, which the editor keeps as
// the document's BASE (doc.base.key names it) and writes back byte-for-byte on export.
//
// Everything is converted to game space (the client mirrors the file in x, see compile.js):
//   model transform  G = S W S for the file's world matrix W (S = mirror x), applied to mirrored
//                    geometry, so G is a proper rotation + scale the gizmo can edit
//   spawns, teleporters: yaw = 270 - stored
//   lights: yaw/pitch of the mirrored direction; camera nodes: yaw/pitch of the mirrored +z axis
import { newDocument, newId, DEFAULT_MATERIALS, defaultEnvironment } from './document.js';
import { NODE } from '../evmap/format.js';

const DEG = 180 / Math.PI;
const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
const mirror = (p) => ({ x: -p.x, y: p.y, z: p.z });
const wrap360 = (v) => ((v % 360) + 360) % 360;

// ------------------------------------------------------------------ small affine maths
// An affine transform is { m: row-major 3x3, t: [x, y, z] }.
export function quatToMat3(q) {
    const { x, y, z, w } = q;
    return [
        1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
        2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
        2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
    ];
}
function trs(p, q, s) {
    const r = quatToMat3(q);
    return { m: [r[0] * s.x, r[1] * s.y, r[2] * s.z, r[3] * s.x, r[4] * s.y, r[5] * s.z, r[6] * s.x, r[7] * s.y, r[8] * s.z], t: [p.x, p.y, p.z] };
}
function mulAffine(a, b) {
    const m = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j] = a.m[i * 3] * b.m[j] + a.m[i * 3 + 1] * b.m[3 + j] + a.m[i * 3 + 2] * b.m[6 + j];
    const t = [0, 1, 2].map((i) => a.m[i * 3] * b.t[0] + a.m[i * 3 + 1] * b.t[1] + a.m[i * 3 + 2] * b.t[2] + a.t[i]);
    return { m, t };
}
// Rotation matrix -> quaternion (three.js setFromRotationMatrix).
export function mat3ToQuat(r) {
    const [m11, m12, m13, m21, m22, m23, m31, m32, m33] = r;
    const tr = m11 + m22 + m33;
    if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); return { w: 0.25 / s, x: (m32 - m23) * s, y: (m13 - m31) * s, z: (m21 - m12) * s }; }
    if (m11 > m22 && m11 > m33) { const s = 2 * Math.sqrt(1 + m11 - m22 - m33); return { w: (m32 - m23) / s, x: 0.25 * s, y: (m12 + m21) / s, z: (m13 + m31) / s }; }
    if (m22 > m33) { const s = 2 * Math.sqrt(1 + m22 - m11 - m33); return { w: (m13 - m31) / s, x: (m12 + m21) / s, y: 0.25 * s, z: (m23 + m32) / s }; }
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    return { w: (m21 - m12) / s, x: (m13 + m31) / s, y: (m23 + m32) / s, z: 0.25 * s };
}
// Euler XYZ (degrees, three.js order) <-> rotation matrix.
export function eulerFromMat3(m) {
    const y = Math.asin(Math.max(-1, Math.min(1, m[2])));
    let x, z;
    if (Math.abs(m[2]) < 0.9999999) { x = Math.atan2(-m[5], m[8]); z = Math.atan2(-m[1], m[0]); }
    else { x = Math.atan2(m[7], m[4]); z = 0; }
    return { x: x * DEG, y: y * DEG, z: z * DEG };
}
export function eulerToQuat(e) {
    const c1 = Math.cos(e.x / DEG / 2), c2 = Math.cos(e.y / DEG / 2), c3 = Math.cos(e.z / DEG / 2);
    const s1 = Math.sin(e.x / DEG / 2), s2 = Math.sin(e.y / DEG / 2), s3 = Math.sin(e.z / DEG / 2);
    return { x: s1 * c2 * c3 + c1 * s2 * s3, y: c1 * s2 * c3 - s1 * c2 * s3, z: c1 * c2 * s3 + s1 * s2 * c3, w: c1 * c2 * c3 - s1 * s2 * s3 };
}

// Split an affine transform into position, rotation (matrix) and scale; `shear` is how far the axes
// are from perpendicular (0 = a clean rotation + scale).
function decompose(a) {
    const m = a.m;
    const col = (j) => [m[j], m[3 + j], m[6 + j]];
    const cols = [col(0), col(1), col(2)];
    const len = cols.map((c) => Math.hypot(...c));
    const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    if (det < 0) len[0] = -len[0];
    const n = cols.map((c, j) => c.map((v) => v / (len[j] || 1)));
    const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
    const shear = Math.max(Math.abs(dot(n[0], n[1])), Math.abs(dot(n[0], n[2])), Math.abs(dot(n[1], n[2])));
    const r = [n[0][0], n[1][0], n[2][0], n[0][1], n[1][1], n[2][1], n[0][2], n[1][2], n[2][2]];
    return { position: { x: a.t[0], y: a.t[1], z: a.t[2] }, rot: r, scale: { x: len[0], y: len[1], z: len[2] }, shear };
}

// ------------------------------------------------------------------ models
// Game-space affine transform of a model (applied to its MIRRORED mesh).
export function modelAffine(model) {
    return trs(model.position, eulerToQuat(model.rotation), model.scale);
}
// File-space node transform for export (the mesh is written unmirrored): W = S G S.
export function modelFileTransform(model) {
    const q = eulerToQuat(model.rotation);
    return { position: mirror(model.position), rotation: { x: q.x, y: -q.y, z: -q.z, w: q.w }, scale: { ...model.scale } };
}

// A model is solid to players when the game would collide with it: collision flag set and its
// collision layer sharing a bit with the player capsule's mask (9).
export const PLAYER_COLLISION_MASK = 9;
export const modelCollides = (m) => !!m.collide && ((m.collisionLayer ?? 1) & PLAYER_COLLISION_MASK) !== 0;

/** Flatten the file's scene tree into models. */
export function modelsFromScene(root) {
    const models = [];
    let sheared = 0, maxShear = 0;
    const walk = (node, parent) => {
        const local = trs(node.transform.position, node.transform.rotation, node.transform.scale);
        const world = parent ? mulAffine(parent, local) : local;
        if ((node.features & (NODE.RENDER | NODE.COLLISION)) && node.targetObjectIndex !== undefined) {
            // Game space: G = S W S.
            const g = { m: world.m.slice(), t: world.t.slice() };
            g.m[1] = -g.m[1]; g.m[2] = -g.m[2]; g.m[3] = -g.m[3]; g.m[6] = -g.m[6]; g.t[0] = -g.t[0];
            const d = decompose(g);
            if (d.shear > 1e-3) sheared++;
            maxShear = Math.max(maxShear, d.shear);
            models.push({
                id: newId('mdl'),
                name: node.name || '',
                mesh: node.targetObjectIndex,
                materials: Array.from(node.materialIndices || []),
                position: d.position,
                rotation: eulerFromMat3(d.rot),
                scale: d.scale,
                render: !!(node.features & NODE.RENDER),
                collide: !!(node.features & NODE.COLLISION),
                shadows: !!(node.features & NODE.SHADOWS),
                collisionLayer: node.collisionLayer ?? 1,
                // A sheared transform (a non-uniform scale under a rotated parent) cannot be written
                // as position/rotation/scale; such a model keeps its exact matrix until it is edited.
                ...(d.shear > 1e-3 ? { matrix: { m: g.m, t: g.t } } : {}),
            });
        }
        for (const c of node.children) walk(c, world);
    };
    walk(root, null);
    return { models, sheared, maxShear };
}

// ------------------------------------------------------------------ the whole map
/**
 * Build an editor document from a parsed .evmap. `key` identifies the stored original file;
 * `name` becomes the map name. Returns { doc, report }.
 */
export function importEvmap(m, { key, name = 'Imported map' } = {}) {
    const doc = newDocument(name);
    doc.blocks = [];
    doc.materials = DEFAULT_MATERIALS.map((x) => ({ ...x }));

    const { models, sheared } = modelsFromScene(m.rootObject);
    doc.models = models;
    models.forEach((md, i) => { if (!md.name) md.name = `Piece ${i + 1}`; });

    // Spawns.
    doc.playerSpawns = m.playerSpawns.map((s) => ({
        id: newId('spawn'), position: mirror(s.position), yaw: wrap360(270 - s.position.w),
        team: s.team1 ? 'team1' : s.team2 ? 'team2' : 'neutral',
    }));
    const weapons = m.weaponSpawnsEx || (m.weaponSpawns || []).map((p) => ({ position: p }));
    doc.weaponSpawns = weapons.map((w) => ({ id: newId('weapon'), position: mirror(w.position), ...(w.spawnList !== undefined ? { spawnList: w.spawnList } : {}) }));

    // Teleporters (destinations by index -> by id).
    const teleIds = (m.teleporters || []).map(() => newId('tele'));
    doc.teleporters = (m.teleporters || []).map((t, i) => ({
        id: teleIds[i], position: mirror(t.position), yaw: wrap360(270 - t.rotation), radius: t.radius,
        destinations: t.destinationIndices.map((j) => teleIds[j]).filter(Boolean),
        ...(t.gameMode ? { gameMode: t.gameMode } : {}),
    }));

    // Nav nodes: store each link once (the game makes every link two-way on load).
    const navIds = (m.aiNavNodes || []).map(() => newId('nav'));
    const seen = new Set();
    doc.navNodes = (m.aiNavNodes || []).map((n, i) => {
        const links = [];
        for (const j of n.neighborIndices) {
            if (j === i || !navIds[j]) continue;
            const k = i < j ? `${i},${j}` : `${j},${i}`;
            if (seen.has(k)) continue;
            seen.add(k);
            links.push(navIds[j]);
        }
        return { id: navIds[i], position: mirror(n.position), links, ...(n.layer ? { layer: n.layer } : {}) };
    });

    // Camera paths: the editor's paths are start -> end; longer ones become consecutive pairs.
    const pose = (node) => {
        const r = quatToMat3(node.rotation);
        const f = mirror({ x: r[2], y: r[5], z: r[8] });   // the node's +z axis, in game space
        const l = Math.hypot(f.x, f.y, f.z) || 1;
        return { position: mirror(node.position), yaw: wrap360(Math.atan2(-f.x, -f.z) * DEG), pitch: Math.asin(Math.max(-1, Math.min(1, f.y / l))) * DEG };
    };
    doc.cameraPaths = [];
    for (const p of m.cameraPaths || []) {
        for (let i = 0; i + 1 < p.nodes.length; i++) {
            doc.cameraPaths.push({ id: newId('cam'), start: pose(p.nodes[i]), end: pose(p.nodes[i + 1]), seconds: p.nodes[i].secsToNextNode > 0 ? p.nodes[i].secsToNextNode : 20 });
        }
    }

    // Lights and environment.
    const caster = m.directionalLights.find((l) => l.features !== 255 && (l.features & 1));
    doc.lights = m.directionalLights.map((l) => {
        const d = mirror(l.direction);
        const len = Math.hypot(d.x, d.y, d.z) || 1;
        return { id: newId('light'), color: hex(l.color), intensity: l.intensity, yaw: wrap360(Math.atan2(d.x, d.z) * DEG), pitch: Math.asin(Math.max(-1, Math.min(1, -d.y / len))) * DEG, castsShadow: l === caster };
    });
    const env = defaultEnvironment();
    if (m.gradientSkybox) Object.assign(env, { skyTop: hex(m.gradientSkybox.top), skyHorizon: hex(m.gradientSkybox.horizon), skyBottom: hex(m.gradientSkybox.bottom) });
    env.fogColor = hex(m.fogColor);
    env.fogDensity = m.fogDensity;
    if (m.hemisphereSkyColor) Object.assign(env, { hemiSky: hex(m.hemisphereSkyColor), hemiGround: hex(m.hemisphereGroundColor), hemiIntensity: m.hemisphereIntensity });
    if (m.cameraFarPlane !== undefined) env.farPlane = m.cameraFarPlane;
    if (caster && caster.shadowStrength !== undefined) env.shadowStrength = caster.shadowStrength;
    doc.environment = env;
    doc.brCircle = m.battleRoyaleCircle ? { position: mirror(m.battleRoyaleCircle), radius: m.battleRoyaleCircle.w } : null;

    // What the editor does not edit, kept so the export keeps it.
    const ss = m.shadowSettings;
    doc.base = {
        key,
        file: name,
        meshCount: m.meshes.length,
        materialCount: (m.materialsEx || m.materials).length,
        materialsEx: !!m.materialsEx,
        // The map's own shadow camera (game space), used while it is still the map's shape.
        shadow: { position: mirror(ss.position), far: ss.far, halfWidth: ss.halfWidth, halfHeight: ss.halfHeight },
        flagSpawns: m.flagSpawns || [],
        bombSites: m.bombSites || [],
    };
    const report = {
        models: models.length, sheared, meshes: m.meshes.length, textures: m.textures.length,
        triangles: m.meshes.reduce((s, x) => s + x.submeshes.reduce((a, sm) => a + sm.indexBuffer.length / 3, 0), 0),
        skybox: m.skybox ? 'cube' : 'gradient',
        dropped: [
            ...(m.skybox ? ['its cube-map sky (replaced with a gradient)'] : []),
            ...(m.lightProbes?.length ? ['light probes'] : []),
            ...(m.legacyAmbient ? ['legacy ambient light'] : []),
            ...(hasLightmaps(m.rootObject) ? ['baked lightmaps'] : []),
        ],
    };
    return { doc, report };
}

function hasLightmaps(n) { return !!(n.features & NODE.LIGHTMAP) || n.children.some(hasLightmaps); }
