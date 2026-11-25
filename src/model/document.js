// The editor's map document: plain JSON, in GAME coordinates (what you see in ev.io).
// compile.js turns it into the .evmap structure; nothing here knows about the file format.

export const DOC_VERSION = 1;

let counter = 0;
export const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`;

export const COLLISION = {
    SOLID: 'solid',          // rendered and collides
    VISUAL: 'visual',        // rendered, players and bullets pass through
    INVISIBLE: 'invisible',  // collides but is not drawn (invisible walls, simplified collision)
};

export const TEAMS = ['neutral', 'team1', 'team2'];

export const DEFAULT_MATERIALS = [
    { id: 'mat_concrete', name: 'Concrete', color: '#9aa1a8', roughness: 0.8 },
    { id: 'mat_floor', name: 'Floor', color: '#6b7178', roughness: 0.7 },
    { id: 'mat_sand', name: 'Sand', color: '#d7c49e', roughness: 0.9 },
    { id: 'mat_brick', name: 'Brick', color: '#a8553f', roughness: 0.85 },
    { id: 'mat_grass', name: 'Grass', color: '#5f8f4a', roughness: 0.9 },
    { id: 'mat_metal', name: 'Metal', color: '#7d8a99', roughness: 0.35 },
    { id: 'mat_wood', name: 'Wood', color: '#8a6440', roughness: 0.75 },
    { id: 'mat_accent', name: 'Accent', color: '#e0a526', roughness: 0.5 },
];

export function defaultEnvironment() {
    // Defaults taken from an official map (Bishop), so a fresh map already looks like ev.io.
    return {
        skyTop: '#4db4ff',
        skyHorizon: '#bfd1ff',
        skyBottom: '#bce1ff',
        fogColor: '#bfd0ff',
        fogDensity: 0.007,
        hemiSky: '#abd4ff',
        hemiGround: '#bb9e8c',
        hemiIntensity: 0.3,
        farPlane: 1000,
        shadowStrength: 0.75,
    };
}

export function defaultLights() {
    // Bishop's three directional lights: a warm and a cool fill, and one white shadow caster.
    // yaw/pitch describe the direction the light TRAVELS (compile.js: lightDirection).
    return [
        { id: newId('light'), color: '#ff6f71', intensity: 0.2, yaw: 145.2, pitch: 40, castsShadow: false },
        { id: newId('light'), color: '#70acff', intensity: 0.3, yaw: 250.6, pitch: 40, castsShadow: false },
        { id: newId('light'), color: '#ffffff', intensity: 1.0, yaw: 50.0, pitch: 40, castsShadow: true },
    ];
}

export function newDocument(name = 'Untitled map') {
    const floor = { id: newId('blk'), shape: 'box', position: { x: 0, y: -0.5, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, size: { x: 60, y: 1, z: 60 }, materialId: 'mat_floor', collision: COLLISION.SOLID, shadows: true };
    return {
        version: DOC_VERSION,
        name,
        materials: DEFAULT_MATERIALS.map((m) => ({ ...m })),
        blocks: [floor],
        models: [],          // pieces of an opened .evmap (see importer.js); their geometry lives in doc.base
        base: null,          // the opened .evmap the models come from (importer.js), or null
        playerSpawns: [
            { id: newId('spawn'), position: { x: -20, y: 0.1, z: 0 }, yaw: 270, team: 'neutral' },
            { id: newId('spawn'), position: { x: 20, y: 0.1, z: 0 }, yaw: 90, team: 'neutral' },
        ],
        weaponSpawns: [],
        teleporters: [],
        navNodes: [],
        cameraPaths: [],
        lights: defaultLights(),
        brCircle: null,
        environment: defaultEnvironment(),
    };
}

// Bring an older or partial document up to the current shape.
export function normaliseDocument(doc) {
    const base = newDocument(doc.name);
    const out = { ...base, ...doc, version: DOC_VERSION };
    out.environment = { ...defaultEnvironment(), ...(doc.environment || {}) };
    if (!out.base) out.base = null;
    for (const key of ['materials', 'blocks', 'models', 'playerSpawns', 'weaponSpawns', 'teleporters', 'navNodes', 'cameraPaths', 'lights']) {
        if (!Array.isArray(out[key])) out[key] = base[key];
    }
    return out;
}

// Pre-export checklist, from ev.io's own map guide.
export function validate(doc) {
    const issues = [];
    const add = (level, text) => issues.push({ level, text });
    if (!doc.playerSpawns.length) add('error', 'No player spawns: everyone would spawn at the map origin.');
    if (!doc.blocks.some((b) => b.collision !== COLLISION.VISUAL) && !(doc.models || []).some((m) => m.collide)) add('error', 'Nothing has collision: players would fall through the map.');
    if (!doc.lights.length) add('error', 'No lights: the map would render black.');
    if (doc.lights.filter((l) => l.castsShadow).length > 1) add('warn', 'More than one shadow-casting light: the game uses only the first.');
    if (!doc.weaponSpawns.length) add('warn', 'No weapon spawns: pickup weapons will not appear.');
    if (!doc.navNodes.length) add('warn', 'No bot nav nodes: bots will stand still.');
    if (!doc.cameraPaths.length) add('warn', 'No camera paths: the menu camera will not move.');
    for (const s of doc.playerSpawns) if (s.position.y < -30) { add('error', 'A player spawn is below the kill zone (y = -30).'); break; }
    if (doc.blocks.length && !(doc.models || []).length && doc.blocks.every((b) => b.position.y < -30)) add('error', 'The whole map is below the kill zone (y = -30).');
    if (doc.teleporters.some((t) => !t.destinations?.length)) add('warn', 'A teleporter has no destination (it will do nothing).');
    return issues;
}
