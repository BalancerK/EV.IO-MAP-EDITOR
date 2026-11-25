// Nav-node generation on a purpose-built map.
//   node tests/test_navgen.js
import { newDocument, newId, COLLISION } from '../src/model/document.js';
import { generateNavNodes, buildCollider, canWalk, spawnsWithoutNav } from '../src/model/navgen.js';

let failures = 0, checks = 0;
const check = (ok, msg) => { checks++; if (!ok) { failures++; console.log('FAIL', msg); } };

const doc = newDocument('nav test');   // 60 x 60 floor, top at y = 0
doc.playerSpawns = [];
const blk = (shape, position, size, extra = {}) => doc.blocks.push({ id: newId('blk'), shape, position, rotation: { x: 0, y: 0, z: 0 }, size, materialId: 'mat_concrete', collision: COLLISION.SOLID, shadows: true, ...extra });
// Wall along x = 0 from z = -30 to z = 30 with a 4 m doorway at z in [-2, 2].
blk('box', { x: 0, y: 2, z: -16 }, { x: 0.5, y: 4, z: 28 });
blk('box', { x: 0, y: 2, z: 16 }, { x: 0.5, y: 4, z: 28 });
// Platform at y = 2 (top) on the east side, reached by a ramp rising towards +z.
blk('box', { x: 18, y: 1, z: 18 }, { x: 10, y: 2, z: 10 });          // top y = 2, z 13..23
blk('ramp', { x: 18, y: 1, z: 9 }, { x: 4, y: 2, z: 8 });            // z 5..13, rises to +z
// Stairs up to a second platform on the west side (6 steps of 0.5 m to y = 3).
blk('box', { x: -18, y: 1.5, z: 18 }, { x: 8, y: 3, z: 8 });         // top y = 3, z 14..22
blk('stairs', { x: -18, y: 1.5, z: 11 }, { x: 3, y: 3, z: 6 }, { steps: 6 }); // z 8..14
// A low ceiling (bottom at 1.2 m) over a patch of floor: no room to stand.
blk('box', { x: -18, y: 1.45, z: -18 }, { x: 8, y: 0.5, z: 8 });     // bottom y = 1.2
// A tall pillar the generator must route around.
blk('box', { x: 18, y: 3, z: -18 }, { x: 3, y: 6, z: 3 });
// An invisible wall (collides) and a decoration block (does not).
blk('box', { x: 10, y: 2, z: -6 }, { x: 0.5, y: 4, z: 8 }, { collision: COLLISION.INVISIBLE });
blk('box', { x: -8, y: 2, z: -6 }, { x: 0.5, y: 4, z: 8 }, { collision: COLLISION.VISUAL });
// An island no one can walk to (2.5 m up, no ramp).
blk('box', { x: 24, y: 1.25, z: -6 }, { x: 4, y: 2.5, z: 4 });
doc.playerSpawns.push({ id: 's1', position: { x: -10, y: 0.1, z: 0 }, yaw: 0, team: 'neutral' });
doc.playerSpawns.push({ id: 's2', position: { x: 24, y: 2.6, z: -6 }, yaw: 0, team: 'neutral' });

const col = buildCollider(doc);
const P = (x, y, z) => ({ x, y, z });

// canWalk checks
check(canWalk(col, P(-10, 0, 0), P(-6, 0, 0)), 'open floor is walkable');
check(!canWalk(col, P(-2, 0, 10), P(2, 0, 10)), 'cannot walk through the wall');
check(canWalk(col, P(-2, 0, 0), P(2, 0, 0)), 'can walk through the doorway');
check(canWalk(col, P(18, 0, 3), P(18, 2, 15)), 'can walk up the ramp onto the platform');
check(canWalk(col, P(-18, 0, 6), P(-18, 3, 16)), 'can climb the stairs onto the platform');
check(!canWalk(col, P(12, 0, 18), P(16, 2, 18)), 'cannot walk up the 2 m side of the platform');
check(!canWalk(col, P(8, 0, -6), P(12, 0, -6)), 'the invisible wall blocks');
check(canWalk(col, P(-10, 0, -6), P(-6, 0, -6)), 'decoration does not block');
check(!canWalk(col, P(-24, 0, -18), P(-18, 0, -18)), 'cannot walk under the low ceiling');

const { nodes, stats } = generateNavNodes(doc, { spacing: 4 });
const byId = new Map(nodes.map((n) => [n.id, n]));
check(stats.nodes > 100 && stats.links > stats.nodes, `a 60x60 map gets a dense graph (${stats.nodes} nodes, ${stats.links} links)`);

// No node inside a solid or under the low ceiling.
const inBox = (p, cx, cz, hx, hz) => Math.abs(p.x - cx) < hx && Math.abs(p.z - cz) < hz;
// Distance from a node to the pillar's 3 x 3 footprint must leave room for the body (0.897).
const toPillar = (p) => Math.hypot(Math.max(0, Math.abs(p.x - 18) - 1.5), Math.max(0, Math.abs(p.z + 18) - 1.5));
check(!nodes.some((n) => toPillar(n.position) < 0.897 - 0.05), `no node inside or hugging the pillar (closest ${Math.min(...nodes.map((n) => toPillar(n.position))).toFixed(2)})`);
check(!nodes.some((n) => inBox(n.position, -18, -18, 4, 4) && n.position.y < 1), 'no node under the low ceiling');
check(!nodes.some((n) => Math.abs(n.position.x) < 0.6 && Math.abs(n.position.z) > 2.5), 'no node inside the wall');
check(nodes.some((n) => Math.abs(n.position.y - 2.1) < 0.01 && inBox(n.position, 18, 18, 5, 5)), 'nodes on the east platform');
check(nodes.some((n) => Math.abs(n.position.y - 3.1) < 0.01 && inBox(n.position, -18, 18, 4, 4)), 'nodes on the west platform');

// No link crosses the wall except through the doorway.
let badCross = 0, doorCross = 0;
for (const n of nodes) for (const id of n.links) {
    const m = byId.get(id);
    if ((n.position.x < 0) !== (m.position.x < 0) && Math.abs(n.position.x) <= 4 && Math.abs(m.position.x) <= 4) {
        const zMid = (n.position.z + m.position.z) / 2;
        if (Math.abs(zMid) > 2) badCross++; else doorCross++;
    }
}
check(badCross === 0, `no link passes through the wall (${badCross})`);
check(doorCross > 0, `links pass through the doorway (${doorCross})`);
// Platforms are connected to the floor.
const area = new Map();
let a = 0;
const adj = new Map(nodes.map((n) => [n.id, new Set()]));
for (const n of nodes) for (const id of n.links) { adj.get(n.id).add(id); adj.get(id).add(n.id); }
for (const n of nodes) {
    if (area.has(n.id)) continue;
    a++; const st = [n.id]; area.set(n.id, a);
    while (st.length) { const c = st.pop(); for (const q of adj.get(c)) if (!area.has(q)) { area.set(q, a); st.push(q); } }
}
const floorArea = area.get(nodes.find((n) => n.position.y < 0.2 && inBox(n.position, -10, 0, 3, 3)).id);
const eastTop = nodes.find((n) => Math.abs(n.position.y - 2.1) < 0.01 && inBox(n.position, 18, 18, 5, 5));
const westTop = nodes.find((n) => Math.abs(n.position.y - 3.1) < 0.01 && inBox(n.position, -18, 18, 4, 4));
check(area.get(eastTop.id) === floorArea, 'the east platform is reachable from the floor (ramp)');
check(area.get(westTop.id) === floorArea, 'the west platform is reachable from the floor (stairs)');
check(stats.areas === a, `areas counted (${stats.areas})`);
check(JSON.stringify(stats.unreachableSpawns) === JSON.stringify([1]) && JSON.stringify(spawnsWithoutNav(doc, nodes)) === '[1]', `the spawn on the unreachable island is reported (${JSON.stringify(stats.unreachableSpawns)})`);

// End to end with the EV.IO custom server: export with the generated graph, parse it with the
// server's own .evmap reader, and route with its bot pathfinder (the server mirrors the nodes back
// into game space on load, so positions compare directly).
{
    const { createRequire } = await import('module');
    const { compileDocument } = await import('../src/model/compile.js');
    const { writeEvmap } = await import('../src/evmap/format.js');
    const serverDir = process.env.EVIO_SERVER_DIR || new URL('../../EV.IO-Custom-Server', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const require = createRequire(import.meta.url);
    let bpw, pf;
    try { bpw = require(`${serverDir}/physics_world.js`); pf = require(`${serverDir}/navmesh_pathfinder.js`); } catch { bpw = null; }
    if (!bpw) console.log('(custom server not found next to this repo: skipping the pathfinder check)');
    else {
        doc.navNodes = nodes;
        const geo = bpw.parseEvmapBuffer(Buffer.from(writeEvmap(compileDocument(doc))), 'navtest');
        check(geo.navmesh.length === nodes.length, `the server reads all ${nodes.length} nav nodes`);
        const graph = pf.buildGraph(geo.navmesh, []);
        for (const [name, target] of [['east platform (ramp)', P(18, 2.1, 18)], ['west platform (stairs)', P(-18, 3.1, 18)]]) {
            const path = pf.findPath(graph, P(-10, 0.1, 0), target);
            const ok = path && path.length > 2 && path.every((n, i) => i === 0 || canWalk(col, { x: path[i - 1].x, y: path[i - 1].y - 0.1, z: path[i - 1].z }, { x: n.x, y: n.y - 0.1, z: n.z }));
            check(ok, `the server's bot pathfinder routes to the ${name}, every step walkable (${path ? path.length : 0} nodes)`);
        }
    }
}

console.log(`${stats.nodes} nodes, ${stats.links} links, ${stats.areas} area(s)`);
console.log(failures ? `${failures}/${checks} FAILED` : `all ${checks} checks passed`);
process.exit(failures ? 1 : 0);
