// Bot nav-node generation. Pure JavaScript (no three.js), so it runs in the editor and in Node tests.
//
// ev.io bots walk a waypoint graph: nodes with links (the client makes every link two-way). This
// fills the walkable floor with nodes on a grid and links the neighbours a bot can actually walk
// between, using the map's collision (solid blocks and invisible walls; decoration has none).
//
//   floor     an upward surface no steeper than MAX_SLOPE, with PLAYER_HEIGHT of free space above,
//             not inside a solid, and with free space a body-width (PLAYER_RADIUS) around it
//   link      walking a straight line in WALK_STEP increments, every step stays on floor, climbs at
//             most STEP_HEIGHT, drops at most MAX_DROP, and never enters a solid or a low ceiling
//
// The body sizes are approximations of the ev.io player, chosen to be conservative.
import { buildBlockTriangles, rotationMatrix } from './geometry.js';
import { COLLISION, newId } from './document.js';

export const NAV = {
    PLAYER_HEIGHT: 1.8,
    PLAYER_RADIUS: 0.35,
    STEP_HEIGHT: 0.55,
    MAX_DROP: 0.75,
    MAX_SLOPE_DEG: 45,
    WALK_STEP: 0.25,
    KILL_Y: -30,
};
const CELL = 4;   // spatial bin size for triangle lookups

/** Collision triangles of the map, binned in XZ for fast vertical-ray queries. */
export function buildCollider(doc) {
    const tris = [];
    for (const b of doc.blocks) {
        if (b.collision === COLLISION.VISUAL) continue;
        const { positions, normals } = buildBlockTriangles(b);
        for (let i = 0; i < positions.length; i += 9) {
            tris.push({
                a: [positions[i], positions[i + 1], positions[i + 2]],
                b: [positions[i + 3], positions[i + 4], positions[i + 5]],
                c: [positions[i + 6], positions[i + 7], positions[i + 8]],
                ny: normals[i + 1],
            });
        }
    }
    const bins = new Map();
    const key = (i, j) => `${i},${j}`;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, maxY = -Infinity;
    tris.forEach((t, idx) => {
        const xs = [t.a[0], t.b[0], t.c[0]], zs = [t.a[2], t.b[2], t.c[2]];
        const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
        minX = Math.min(minX, x0); maxX = Math.max(maxX, x1); minZ = Math.min(minZ, z0); maxZ = Math.max(maxZ, z1);
        maxY = Math.max(maxY, t.a[1], t.b[1], t.c[1]);
        for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++)
            for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
                const k = key(i, j);
                if (!bins.has(k)) bins.set(k, []);
                bins.get(k).push(idx);
            }
    });
    return {
        tris, bounds: { minX, maxX, minZ, maxZ, maxY },
        /** Every surface crossing the vertical line at (x, z): [{ y, up }] sorted from the top. */
        column(x, z) {
            const list = bins.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) || [];
            const hits = [];
            for (const idx of list) {
                const t = tris[idx];
                const y = verticalHit(t, x, z);
                if (y !== null && Math.abs(t.ny) > 1e-6) hits.push({ y, up: t.ny > 0, ny: t.ny });
            }
            hits.sort((p, q) => q.y - p.y);
            return hits;
        },
    };
}

// Height where the vertical line through (x, z) crosses triangle t, or null.
function verticalHit(t, x, z) {
    const [ax, ay, az] = t.a, [bx, by, bz] = t.b, [cx, cy, cz] = t.c;
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-12) return null;
    const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
    const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
    const l3 = 1 - l1 - l2;
    const e = -1e-9;
    if (l1 < e || l2 < e || l3 < e) return null;
    return l1 * ay + l2 * by + l3 * cy;
}

const minUp = Math.cos(NAV.MAX_SLOPE_DEG * Math.PI / 180);

// Is the body standing at (x, y, z) free: nothing between its feet and head, and not inside a solid?
function bodyFree(col, x, y, z) {
    const hits = col.column(x, z);
    for (const h of hits) if (h.y > y + 0.05 && h.y < y + NAV.PLAYER_HEIGHT) return false;
    // Inside a closed solid, the first surface above the waist faces up (it is the solid's top).
    const waist = y + NAV.PLAYER_HEIGHT / 2;
    let above = null;
    for (const h of hits) if (h.y > waist) above = h; else break;
    return !(above && above.up);
}

// The floor a walker at height y can step onto at (x, z): the highest walkable surface no more than
// STEP_HEIGHT above and no more than MAX_DROP below. Null if there is none.
function floorNear(col, x, z, y) {
    for (const h of col.column(x, z)) {
        if (h.y > y + NAV.STEP_HEIGHT) continue;
        if (h.y < y - NAV.MAX_DROP) return null;
        if (h.up && h.ny >= minUp) return h.y;
    }
    return null;
}

/** Walkable floor points in the column at (x, z) (one per level). */
function floorsAt(col, x, z) {
    const out = [];
    for (const h of col.column(x, z)) {
        if (!h.up || h.ny < minUp || h.y < NAV.KILL_Y) continue;
        if (!bodyFree(col, x, h.y, z)) continue;
        // Room for a body: the same floor (or a step of it) all around, and no wall within reach.
        let ok = true;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const ox = x + dx * NAV.PLAYER_RADIUS, oz = z + dz * NAV.PLAYER_RADIUS;
            const f = floorNear(col, ox, oz, h.y);
            if (f === null || Math.abs(f - h.y) > NAV.STEP_HEIGHT || !bodyFree(col, ox, f, oz)) { ok = false; break; }
        }
        if (ok) out.push(h.y);
    }
    return out;
}

/** Can a bot walk in a straight line from a to b? */
export function canWalk(col, a, b) {
    const dist = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(dist / NAV.WALK_STEP));
    let y = a.y;
    for (let i = 1; i <= n; i++) {
        const k = i / n;
        const x = a.x + (b.x - a.x) * k, z = a.z + (b.z - a.z) * k;
        const f = floorNear(col, x, z, y);
        if (f === null || !bodyFree(col, x, f, z)) return false;
        y = f;
    }
    return Math.abs(y - b.y) < 0.05;
}

/**
 * Generate nav nodes. Returns { nodes, stats } where nodes are document nav nodes
 * ({ id, position, links }) and stats = { nodes, links, areas, unreachableSpawns: [index...] }.
 */
export function generateNavNodes(doc, { spacing = 4 } = {}) {
    const col = buildCollider(doc);
    if (!col.tris.length) return { nodes: [], stats: { nodes: 0, links: 0, areas: 0, unreachableSpawns: [] } };
    const { minX, maxX, minZ, maxZ } = col.bounds;
    const points = [];
    const add = (x, z) => { for (const y of floorsAt(col, x, z)) points.push({ x, y, z, links: new Set() }); };
    // 1. A grid over the whole map.
    for (let x = Math.ceil(minX / spacing) * spacing; x <= maxX; x += spacing)
        for (let z = Math.ceil(minZ / spacing) * spacing; z <= maxZ; z += spacing) add(x, z);
    // 2. Centre lines of ramps, stairs and walkways narrower than the grid, which the grid can miss
    //    entirely (a 4 m ramp between two grid lines). Ramps and stairs run along their own z.
    const featureStep = Math.min(2, spacing / 2);
    for (const b of doc.blocks) {
        if (b.collision === COLLISION.VISUAL || b.shape === 'cylinder' || b.shape === 'wedge-corner') continue;
        if (Math.abs(b.rotation.x) > 1 || Math.abs(b.rotation.z) > 1) continue;   // tilted: skip
        const sloped = b.shape === 'ramp' || b.shape === 'stairs';
        const narrow = Math.min(b.size.x, b.size.z) < spacing * 1.2;
        if (!sloped && !narrow) continue;
        const alongZ = sloped || b.size.z >= b.size.x;
        const len = alongZ ? b.size.z : b.size.x;
        const m = rotationMatrix(b.rotation);
        for (let t = -len / 2 + featureStep / 2; t <= len / 2; t += featureStep) {
            const lx = alongZ ? 0 : t, lz = alongZ ? t : 0;
            add(b.position.x + m[0] * lx + m[2] * lz, b.position.z + m[6] * lx + m[8] * lz);
        }
        // Just beyond both ends, so the line joins the floor or platform it leads to.
        for (const t of [-len / 2 - featureStep, len / 2 + featureStep]) {
            const lx = alongZ ? 0 : t, lz = alongZ ? t : 0;
            add(b.position.x + m[0] * lx + m[2] * lz, b.position.z + m[6] * lx + m[8] * lz);
        }
    }
    // Drop points crowding an earlier one on the same level.
    const kept0 = [];
    const near = spacing * 0.35;
    for (const p of points) if (!kept0.some((q) => Math.abs(q.y - p.y) < 0.3 && Math.hypot(q.x - p.x, q.z - p.z) < near)) kept0.push(p);
    points.length = 0; points.push(...kept0);

    // 3. Link every pair within reach that a bot can walk both ways (bots use links in both directions).
    const reach = spacing * 1.5;
    const hash = new Map();
    const hk = (x, z) => `${Math.floor(x / reach)},${Math.floor(z / reach)}`;
    points.forEach((p, idx) => { p.idx = idx; const k = hk(p.x, p.z); if (!hash.has(k)) hash.set(k, []); hash.get(k).push(p); });
    for (const p of points) {
        const ci = Math.floor(p.x / reach), cj = Math.floor(p.z / reach);
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
            for (const q of hash.get(`${ci + di},${cj + dj}`) || []) {
                if (q.idx <= p.idx || p.links.has(q)) continue;
                if (Math.hypot(q.x - p.x, q.z - p.z) > reach) continue;
                if (Math.abs(q.y - p.y) > reach + NAV.STEP_HEIGHT) continue;
                if (canWalk(col, p, q) && canWalk(col, q, p)) { p.links.add(q); q.links.add(p); }
            }
        }
    }
    const kept = points.filter((p) => p.links.size);
    const r3 = (v) => Math.round(v * 1000) / 1000;
    kept.forEach((p) => { p.id = newId('nav'); });
    // Store each link once (the game makes links two-way on load).
    const nodes = kept.map((p) => ({
        id: p.id,
        position: { x: r3(p.x), y: r3(p.y + 0.1), z: r3(p.z) },
        links: [...p.links].filter((q) => q.idx > p.idx).map((q) => q.id),
    }));

    const report = navReport(doc, nodes);
    const links = nodes.reduce((s, n) => s + n.links.length, 0);
    return { nodes, stats: { nodes: nodes.length, links, areas: report.areas, unreachableSpawns: report.unreachableSpawns } };
}

/**
 * How well the nav graph covers the map: the number of separate areas, and the player spawns a bot
 * cannot reach — no node within 6 m at about the spawn's height, or only nodes outside the main
 * (largest) area, e.g. an island the rest of the map does not connect to.
 */
export function navReport(doc, nodes = doc.navNodes) {
    const adj = new Map(nodes.map((n) => [n.id, new Set()]));
    for (const n of nodes) for (const id of n.links || []) if (adj.has(id)) { adj.get(n.id).add(id); adj.get(id).add(n.id); }
    const area = new Map();
    const sizes = [];
    for (const n of nodes) {
        if (area.has(n.id)) continue;
        const a = sizes.length;
        sizes.push(0);
        const st = [n.id];
        area.set(n.id, a);
        while (st.length) { const c = st.pop(); sizes[a]++; for (const q of adj.get(c)) if (!area.has(q)) { area.set(q, a); st.push(q); } }
    }
    const main = sizes.indexOf(Math.max(...sizes, 0));
    const unreachableSpawns = [];
    doc.playerSpawns.forEach((s, i) => {
        const ok = nodes.some((n) => area.get(n.id) === main
            && Math.hypot(n.position.x - s.position.x, n.position.z - s.position.z) <= 6 && Math.abs(n.position.y - s.position.y) <= 2);
        if (!ok) unreachableSpawns.push(i);
    });
    return { areas: sizes.length, mainArea: sizes[main] || 0, unreachableSpawns };
}

/** Indices of player spawns bots cannot reach (see navReport). */
export function spawnsWithoutNav(doc, nodes = doc.navNodes) { return navReport(doc, nodes).unreachableSpawns; }
