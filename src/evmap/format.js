// .evmap read/write, mirroring the ev.io client's readEVMapFile (bundle 1-7-1) field for field.
// The object shape is exactly what the client's reader returns, so a file written from it and read
// back by the client yields the same structure.
//
// File layout (all lists are u16 count + items):
//   u8 magic = 3, u8 features, [u8 featuresExt if features & 128]
//   meshes, textures, materials (materialsEx if features & 64), rootObject (scene tree)
//   weapon spawns (rich form if features & 32), player spawns (team flags if featuresExt & 64)
//   directional lights, shadow settings, sky (gradient if features & 4, else 6 cube-face indices)
//   fog colour + density, [legacy rgb24 + f32 unless features & 8]
//   [hemisphere light if features & 1], [light probes if & 2], [camera paths if & 16]
//   [ext & 1 AI nav nodes] [ext & 2 battle-royale circle] [ext & 32 flag spawns]
//   [ext & 4 teleporters] [ext & 128 bomb sites] [ext & 8 camera far plane]

import { BinaryReader, BinaryWriter } from './binary.js';

export const F = { HEMISPHERE: 1, LIGHT_PROBES: 2, GRADIENT_SKY: 4, NO_LEGACY_AMBIENT: 8, CAMERA_PATHS: 16, WEAPON_SPAWNS_EX: 32, MATERIALS_EX: 64, EXT: 128 };
export const FX = { AI_NAV: 1, BR_CIRCLE: 2, TELEPORTERS: 4, FAR_PLANE: 8, FLAG_SPAWNS: 32, TEAM_SPAWNS: 64, BOMB_SITES: 128 };
// Scene-node features.
export const NODE = { NAME: 1, RENDER: 2, COLLISION: 4, LIGHTMAP: 8, SHADOWS: 16, COLLISION_LAYER: 32 };
// Mesh features.
export const MESH = { NORMALS: 1, UV: 2, LIGHT_UV: 4, PALETTE_UV: 8 };
// Material features (+ features2 when features & 128).
export const MAT = { COLOR: 1, COLOR_MAP: 2, EMISSION: 4, EMISSION_MAP: 8, EMISSION_INTENSITY: 16, METALLIC: 32, METALLIC_MAP: 64, EXT: 128 };
export const MAT2 = { ROUGHNESS: 1, ROUGHNESS_MAP: 2, OCCLUSION_MAP: 4, OCCLUSION_MULT: 8, NORMAL_MAP: 16, UV_SCALE_OFFSET: 32 };
// Directional-light features.
export const LIGHT = { CASTS_SHADOW: 1, SHADOW_STRENGTH: 2 };

// ------------------------------------------------------------------ read

// Meshes and materials also keep their exact bytes (`raw`), so a map opened in the editor writes
// its original geometry and materials back unchanged instead of re-encoding them.
function readMesh(r) {
    const start = r.pos;
    const features = r.u8();
    const m = { features, vertexBuffer: r.boundedVec3(), submeshes: r.list((r) => ({ indexBuffer: r.u16ArrayN(r.u16()) })) };
    if (features & MESH.NORMALS) m.normalBuffer = r.boundedVec3();
    if (features & MESH.UV) m.uvBuffer = r.boundedVec2();
    if (features & MESH.LIGHT_UV) m.lightUvBuffer = r.boundedVec2();
    if (features & MESH.PALETTE_UV) { m.features |= MESH.UV; m.uvBuffer = r.paletteUv(); }
    m.raw = r.bytes.slice(start, r.pos);
    return m;
}

function readTexture(r) {
    const format = r.u8();
    const data = r.bytesN(r.u32());
    return { format, data };   // 0 = png, 1 = jpeg
}

function readMaterial(r) {
    const start = r.pos;
    const features = r.u8();
    const m = { features };
    if (features & MAT.EXT) m.features2 = r.u8();
    if (features & MAT.COLOR) { const c = r.rgba32(); m.color = { r: c.r, g: c.g, b: c.b }; m.colorAlpha = c.a; }
    if (features & MAT.COLOR_MAP) m.colorMapIndex = r.u16();
    if (features & MAT.EMISSION) m.emissionColor = r.rgb24();
    if (features & MAT.EMISSION_MAP) m.emissionMapIndex = r.u16();
    if (features & MAT.EMISSION_INTENSITY) m.emissionIntensity = r.f32();
    if (features & MAT.METALLIC) m.metallic = r.f32();
    if (features & MAT.METALLIC_MAP) m.metallicMapIndex = r.u16();
    if (features & MAT.EXT) {
        const f2 = m.features2;
        if (f2 & MAT2.ROUGHNESS) m.roughness = r.f32();
        if (f2 & MAT2.ROUGHNESS_MAP) m.roughnessMapIndex = r.i16();
        if (f2 & MAT2.OCCLUSION_MAP) m.occlusionMapIndex = r.i16();
        if (f2 & MAT2.OCCLUSION_MULT) m.occlusionMultiplier = r.f32();
        if (f2 & MAT2.NORMAL_MAP) m.normalMapIndex = r.i16();
        if (f2 & MAT2.UV_SCALE_OFFSET) m.uvScaleOffset = r.vec4();
    }
    m.raw = r.bytes.slice(start, r.pos);
    return m;
}

// Shaders: 0 standard (toon-lit in game), 1 toon (drawn unlit), 2 unlit colour, 3 billboard (no data).
function readMaterialEx(r) {
    const shader = r.u8();
    const start = r.pos;
    let material;
    if (shader === 0) material = readMaterial(r);
    else if (shader === 1) material = { color: r.rgba32(), mainTextureIndex: r.u16(), ambientColor: r.vec4(), specularColor: r.vec4(), glossiness: r.f32(), rimColor: r.vec4(), rimAmount: r.f32(), rimThreshold: r.f32(), outlineThickness: r.f32(), outlineColor: r.rgba32() };
    else if (shader === 2) material = { color: r.rgb24() };
    return { shader, material, raw: r.bytes.slice(start, r.pos) };
}

function readNode(r) {
    const features = r.u8();
    const n = { features, transform: { position: r.vec3(), rotation: r.quat(), scale: r.vec3() } };
    n.children = r.list(readNode);
    if (features & NODE.NAME) n.name = r.string();
    if (features !== 0) n.targetObjectIndex = r.u16();
    if (features & NODE.RENDER) n.materialIndices = r.u16ArrayLen16();
    n.collisionLayer = (features & NODE.COLLISION_LAYER) ? r.u32() : 1;
    if (features & NODE.LIGHTMAP) {
        n.lightmapTextureIndex = r.u16();
        n.lightmapTilingX = r.f32(); n.lightmapTilingY = r.f32();
        n.lightmapOffsetX = r.f32(); n.lightmapOffsetY = r.f32();
    }
    return n;
}

function readLight(r) {
    const l = { direction: r.vec3(), color: r.rgb24(), intensity: r.f32(), features: r.u8(), shadowStrength: 1 };
    if (l.features !== 255 && (l.features & LIGHT.SHADOW_STRENGTH)) l.shadowStrength = r.f32();
    return l;
}

export function readEvmap(arrayBuffer) {
    const r = new BinaryReader(arrayBuffer);
    const magic = r.u8();
    if (magic !== 3) throw new Error('Not an .evmap file (first byte must be 3)');
    const features = r.u8();
    const m = { features, featuresExt: 0 };
    if (features & F.EXT) m.featuresExt = r.u8();
    const ext = m.featuresExt;
    m.meshes = r.list(readMesh);
    m.textures = r.list(readTexture);
    if (features & F.MATERIALS_EX) m.materialsEx = r.list(readMaterialEx);
    else m.materials = r.list(readMaterial);
    m.rootObject = readNode(r);
    if (features & F.WEAPON_SPAWNS_EX) m.weaponSpawnsEx = r.list((r) => { const f = r.u8(); return { features: f, position: r.vec3(), spawnList: (f & 1) ? r.u32() : r.u8() }; });
    else m.weaponSpawns = r.list((r) => r.vec3());
    m.playerSpawns = r.list((ext & FX.TEAM_SPAWNS)
        ? (r) => { const position = r.vec4(); const f = r.u8(); return { position, neutral: !!(f & 1), team1: !!(f & 2), team2: !!(f & 4) }; }
        : (r) => ({ position: r.vec4(), neutral: true, team1: false, team2: false }));
    m.directionalLights = r.list(readLight);
    m.shadowSettings = { position: r.vec3(), far: r.f32(), halfWidth: r.f32(), halfHeight: r.f32() };
    m.skybox = null; m.gradientSkybox = null;
    if (features & F.GRADIENT_SKY) m.gradientSkybox = { features: r.u8(), bottom: r.rgb24(), horizon: r.rgb24(), top: r.rgb24() };
    else m.skybox = { frontIndex: r.u16(), backIndex: r.u16(), upIndex: r.u16(), downIndex: r.u16(), rightIndex: r.u16(), leftIndex: r.u16() };
    m.fogColor = r.rgb24();
    m.fogDensity = r.f32();
    if (!(features & F.NO_LEGACY_AMBIENT)) m.legacyAmbient = { color: r.rgb24(), value: r.f32() };
    if (features & F.HEMISPHERE) { m.hemisphereSkyColor = r.rgb24(); m.hemisphereGroundColor = r.rgb24(); m.hemisphereIntensity = r.f32(); }
    if (features & F.LIGHT_PROBES) m.lightProbes = r.list((r) => ({ position: r.vec3(), harmonics: r.list((r) => r.vec3()) }));
    if (features & F.CAMERA_PATHS) m.cameraPaths = r.list((r) => ({ nodes: r.list((r) => ({ position: r.vec3(), rotation: r.quat(), secsToNextNode: r.f32() })) }));
    if (ext & FX.AI_NAV) m.aiNavNodes = r.list((r) => { const f = r.u8(); const position = r.vec3(); const neighborIndices = Array.from(r.u16ArrayN(r.u16())); return { features: f, position, neighborIndices, layer: (f & 1) ? r.string() : '' }; });
    if (ext & FX.BR_CIRCLE) m.battleRoyaleCircle = r.vec4();
    if (ext & FX.FLAG_SPAWNS) m.flagSpawns = r.list((r) => ({ features: r.u8(), position: r.vec3() }));
    if (ext & FX.TELEPORTERS) m.teleporters = r.list((r) => { const f = r.u8(); const t = { features: f, position: r.vec3(), rotation: r.f32(), radius: r.f32(), destinationIndices: Array.from(r.u16ArrayN(r.u16())) }; t.gameMode = (f & 1) ? r.string() : ''; return t; });
    if (ext & FX.BOMB_SITES) m.bombSites = r.list((r) => ({ position: r.vec3(), radius: r.f32() }));
    if (ext & FX.FAR_PLANE) m.cameraFarPlane = r.f32();
    m.bytesRead = r.pos;
    m.bytesTotal = r.bytes.length;
    return m;
}

// ------------------------------------------------------------------ write

function writeMesh(w, m) {
    if (m.raw) { w.bytesN(m.raw); return; }
    let f = m.features & ~MESH.PALETTE_UV & ~MESH.LIGHT_UV;
    if (m.normalBuffer && m.normalBuffer.length) f |= MESH.NORMALS; else f &= ~MESH.NORMALS;
    if (m.uvBuffer && m.uvBuffer.length) f |= MESH.UV; else f &= ~MESH.UV;
    w.u8(f);
    w.boundedVec3(m.vertexBuffer);
    w.list(m.submeshes, (w, s) => { w.u16(s.indexBuffer.length); w.u16Array(s.indexBuffer); });
    if (f & MESH.NORMALS) w.boundedVec3(m.normalBuffer);
    if (f & MESH.UV) w.boundedVec2(m.uvBuffer);
}

function writeMaterial(w, m) {
    if (m.raw) { w.bytesN(m.raw); return; }
    let f = MAT.COLOR;
    let f2 = 0;
    if (m.colorMapIndex !== undefined) f |= MAT.COLOR_MAP;
    if (m.emissionColor) f |= MAT.EMISSION;
    if (m.emissionIntensity !== undefined) f |= MAT.EMISSION_INTENSITY;
    if (m.metallic !== undefined) f |= MAT.METALLIC;
    if (m.roughness !== undefined) f2 |= MAT2.ROUGHNESS;
    if (f2) f |= MAT.EXT;
    w.u8(f);
    if (f & MAT.EXT) w.u8(f2);
    w.rgba32({ ...m.color, a: m.colorAlpha ?? 1 });
    if (f & MAT.COLOR_MAP) w.u16(m.colorMapIndex);
    if (f & MAT.EMISSION) w.rgb24(m.emissionColor);
    if (f & MAT.EMISSION_INTENSITY) w.f32(m.emissionIntensity);
    if (f & MAT.METALLIC) w.f32(m.metallic);
    if (f2 & MAT2.ROUGHNESS) w.f32(m.roughness);
}

function writeNode(w, n) {
    let f = n.features & (NODE.RENDER | NODE.COLLISION | NODE.SHADOWS);
    if (n.name) f |= NODE.NAME;
    if (n.collisionLayer !== undefined && n.collisionLayer !== 1) f |= NODE.COLLISION_LAYER;
    w.u8(f);
    w.vec3(n.transform.position); w.quat(n.transform.rotation); w.vec3(n.transform.scale);
    w.list(n.children || [], writeNode);
    if (f & NODE.NAME) w.string(n.name);
    if (f !== 0) w.u16(n.targetObjectIndex ?? 0);
    if (f & NODE.RENDER) w.u16ArrayLen16(n.materialIndices);
    if (f & NODE.COLLISION_LAYER) w.u32(n.collisionLayer);
}

function writeMaterialEx(w, e) {
    w.u8(e.shader);
    if (e.raw) w.bytesN(e.raw);
    else if (e.shader === 0) writeMaterial(w, e.material);
    else if (e.shader !== 3) throw new Error(`cannot encode a shader ${e.shader} material without its original bytes`);
}

// `m` uses the same shape readEvmap returns. Supported: plain or extended materials (extended ones
// other than shader 0 only with their original bytes), plain or extended weapon spawns, team
// spawns, gradient sky. Meshes and materials with `raw` bytes are written verbatim.
export function writeEvmap(m) {
    const w = new BinaryWriter();
    let features = F.GRADIENT_SKY | F.NO_LEGACY_AMBIENT | F.EXT;
    if (m.materialsEx) features |= F.MATERIALS_EX;
    if (m.weaponSpawnsEx) features |= F.WEAPON_SPAWNS_EX;
    if (m.hemisphereSkyColor) features |= F.HEMISPHERE;
    if (m.cameraPaths && m.cameraPaths.length) features |= F.CAMERA_PATHS;
    let ext = FX.TEAM_SPAWNS;
    if (m.aiNavNodes && m.aiNavNodes.length) ext |= FX.AI_NAV;
    if (m.battleRoyaleCircle) ext |= FX.BR_CIRCLE;
    if (m.flagSpawns && m.flagSpawns.length) ext |= FX.FLAG_SPAWNS;
    if (m.teleporters && m.teleporters.length) ext |= FX.TELEPORTERS;
    if (m.bombSites && m.bombSites.length) ext |= FX.BOMB_SITES;
    if (m.cameraFarPlane !== undefined) ext |= FX.FAR_PLANE;

    w.u8(3); w.u8(features); w.u8(ext);
    w.list(m.meshes, writeMesh);
    w.list(m.textures || [], (w, t) => { w.u8(t.format); w.u32(t.data.length); w.bytesN(t.data); });
    if (m.materialsEx) w.list(m.materialsEx, writeMaterialEx);
    else w.list(m.materials, writeMaterial);
    writeNode(w, m.rootObject);
    if (m.weaponSpawnsEx) w.list(m.weaponSpawnsEx, (w, s) => {
        const f = (s.features & 1) || s.spawnList > 255 ? 1 : 0;
        w.u8(f); w.vec3(s.position);
        if (f & 1) w.u32(s.spawnList); else w.u8(s.spawnList);
    });
    else w.list(m.weaponSpawns || [], (w, p) => w.vec3(p));
    w.list(m.playerSpawns || [], (w, s) => { w.vec4(s.position); w.u8((s.neutral ? 1 : 0) | (s.team1 ? 2 : 0) | (s.team2 ? 4 : 0)); });
    w.list(m.directionalLights || [], (w, l) => {
        let f = l.features & LIGHT.CASTS_SHADOW;
        if (l.shadowStrength !== undefined && l.shadowStrength !== 1) f |= LIGHT.SHADOW_STRENGTH;
        w.vec3(l.direction); w.rgb24(l.color); w.f32(l.intensity); w.u8(f);
        if (f & LIGHT.SHADOW_STRENGTH) w.f32(l.shadowStrength);
    });
    const ss = m.shadowSettings;
    w.vec3(ss.position); w.f32(ss.far); w.f32(ss.halfWidth); w.f32(ss.halfHeight);
    const sky = m.gradientSkybox;
    w.u8(sky.features ?? 0); w.rgb24(sky.bottom); w.rgb24(sky.horizon); w.rgb24(sky.top);
    w.rgb24(m.fogColor); w.f32(m.fogDensity);
    if (features & F.HEMISPHERE) { w.rgb24(m.hemisphereSkyColor); w.rgb24(m.hemisphereGroundColor); w.f32(m.hemisphereIntensity); }
    if (features & F.CAMERA_PATHS) w.list(m.cameraPaths, (w, p) => w.list(p.nodes, (w, n) => { w.vec3(n.position); w.quat(n.rotation); w.f32(n.secsToNextNode); }));
    if (ext & FX.AI_NAV) w.list(m.aiNavNodes, (w, n) => {
        const f = n.layer ? 1 : 0;
        w.u8(f); w.vec3(n.position); w.u16ArrayLen16(n.neighborIndices);
        if (f) w.string(n.layer);
    });
    if (ext & FX.BR_CIRCLE) w.vec4(m.battleRoyaleCircle);
    if (ext & FX.FLAG_SPAWNS) w.list(m.flagSpawns, (w, s) => { w.u8(s.features ?? 0); w.vec3(s.position); });
    if (ext & FX.TELEPORTERS) w.list(m.teleporters, (w, t) => {
        const f = t.gameMode ? 1 : 0;
        w.u8(f); w.vec3(t.position); w.f32(t.rotation); w.f32(t.radius); w.u16ArrayLen16(t.destinationIndices);
        if (f) w.string(t.gameMode);
    });
    if (ext & FX.BOMB_SITES) w.list(m.bombSites, (w, b) => { w.vec3(b.position); w.f32(b.radius); });
    if (ext & FX.FAR_PLANE) w.f32(m.cameraFarPlane);
    return w.result();
}
