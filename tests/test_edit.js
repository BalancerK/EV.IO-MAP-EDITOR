// Editing operations: mirror/rotate produce exactly the reflected/rotated geometry, facings follow,
// copy/paste remaps ids and links, clipboard text round-trips.
//   node tests/test_edit.js
import { buildBlockTriangles, SHAPES } from '../src/model/geometry.js';
import { mirror, rotateY, remapIds, collect, toClipboardText, fromClipboardText, removeSelection, insert, centreOf } from '../src/model/edit.js';
import { cameraForward } from '../src/model/compile.js';
import { newDocument, newId } from '../src/model/document.js';

let failures = 0, checks = 0;
const check = (ok, msg) => { checks++; if (!ok) { failures++; console.log('FAIL', msg); } };
const clone = (o) => JSON.parse(JSON.stringify(o));

// Corner points of a block (optionally mapped), and a tolerant same-set comparison.
function corners(block, map = (p) => p) {
    const { positions } = buildBlockTriangles(block);
    const pts = [];
    for (let i = 0; i < positions.length; i += 3) pts.push(map({ x: positions[i], y: positions[i + 1], z: positions[i + 2] }));
    return pts;
}
function sameShape(a, b, tol = 2e-3) {
    const covers = (p, q) => p.every((u) => q.some((v) => Math.abs(u.x - v.x) < tol && Math.abs(u.y - v.y) < tol && Math.abs(u.z - v.z) < tol));
    return covers(a, b) && covers(b, a);
}

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const randomRot = () => ({ x: Math.round(rnd() * 8) * 15 - 60, y: Math.round(rnd() * 24) * 15, z: Math.round(rnd() * 8) * 15 - 60 });

for (const shape of SHAPES) {
    for (let k = 0; k < 6; k++) {
        const block = { id: 'b', shape, steps: 5, segments: 12, position: { x: rnd() * 20 - 10, y: rnd() * 5, z: rnd() * 20 - 10 }, rotation: k === 0 ? { x: 0, y: 0, z: 0 } : randomRot(), size: { x: 2 + rnd() * 4, y: 1 + rnd() * 3, z: 2 + rnd() * 6 } };
        for (const axis of ['x', 'z']) {
            const plane = 3;
            const g = mirror({ blocks: [clone(block)] }, axis, plane);
            const want = corners(block, (p) => (axis === 'x' ? { ...p, x: 2 * plane - p.x } : { ...p, z: 2 * plane - p.z }));
            check(sameShape(corners(g.blocks[0]), want), `${shape} mirror ${axis} (rot ${JSON.stringify(block.rotation)}) reproduces the reflected shape`);
        }
        const pivot = { x: 1, y: 0, z: -2 };
        for (const deg of [90, -90, 45]) {
            const g = rotateY({ blocks: [clone(block)] }, deg, pivot);
            const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
            const want = corners(block, (p) => ({ x: pivot.x + (p.x - pivot.x) * c + (p.z - pivot.z) * s, y: p.y, z: pivot.z - (p.x - pivot.x) * s + (p.z - pivot.z) * c }));
            check(sameShape(corners(g.blocks[0]), want), `${shape} rotate ${deg}° (rot ${JSON.stringify(block.rotation)}) reproduces the rotated shape`);
        }
    }
}

// Facings: a mirrored/rotated spawn faces the mirrored/rotated direction.
for (const yaw of [0, 30, 90, 200, 315]) {
    const f = cameraForward(yaw, 0);
    const mx = mirror({ playerSpawns: [{ id: 's', position: { x: 0, y: 0, z: 0 }, yaw, team: 'team1' }] }, 'x', 0, { swapTeams: true }).playerSpawns[0];
    const fx = cameraForward(mx.yaw, 0);
    check(Math.abs(fx.x + f.x) < 1e-6 && Math.abs(fx.z - f.z) < 1e-6, `mirror x flips facing x (yaw ${yaw} -> ${mx.yaw})`);
    check(mx.team === 'team2', 'mirror with swapTeams swaps team 1 to team 2');
    const mz = mirror({ teleporters: [{ id: 't', position: { x: 0, y: 0, z: 0 }, yaw, destinations: [] }] }, 'z', 0).teleporters[0];
    const fz = cameraForward(mz.yaw, 0);
    check(Math.abs(fz.z + f.z) < 1e-6 && Math.abs(fz.x - f.x) < 1e-6, `mirror z flips facing z (yaw ${yaw} -> ${mz.yaw})`);
    const r = rotateY({ playerSpawns: [{ id: 's', position: { x: 5, y: 0, z: 0 }, yaw }] }, 90, { x: 0, y: 0, z: 0 }).playerSpawns[0];
    const fr = cameraForward(r.yaw, 0);
    const a = Math.PI / 2;
    check(Math.abs(fr.x - (f.x * Math.cos(a) + f.z * Math.sin(a))) < 1e-6 && Math.abs(fr.z - (-f.x * Math.sin(a) + f.z * Math.cos(a))) < 1e-6, `rotate 90° turns facing with the position (yaw ${yaw})`);
}

// Copy/paste: fresh ids, internal links kept, external links dropped; clipboard round trip.
const doc = newDocument('t');
const n1 = { id: newId('nav'), position: { x: 0, y: 0, z: 0 }, links: [] };
const n2 = { id: newId('nav'), position: { x: 5, y: 0, z: 0 }, links: [] };
const n3 = { id: newId('nav'), position: { x: 9, y: 0, z: 0 }, links: [] };
n1.links = [n2.id, n3.id];
doc.navNodes.push(n1, n2, n3);
const t1 = { id: newId('tp'), position: { x: 0, y: 0, z: 0 }, yaw: 0, radius: 1.5, destinations: [] };
const t2 = { id: newId('tp'), position: { x: 0, y: 0, z: 9 }, yaw: 0, radius: 1.5, destinations: [] };
t1.destinations = [t2.id]; t2.destinations = [t1.id];
doc.teleporters.push(t1, t2);
const sel = [{ kind: 'navNodes', id: n1.id }, { kind: 'navNodes', id: n2.id }, { kind: 'teleporters', id: t1.id }, { kind: 'block', id: doc.blocks[0].id }];
const copied = remapIds(collect(doc, sel));
check(copied.navNodes.length === 2 && copied.navNodes.every((n) => ![n1.id, n2.id].includes(n.id)), 'pasted items get new ids');
check(copied.navNodes[0].links.length === 1 && copied.navNodes[0].links[0] === copied.navNodes[1].id, 'a link inside the copy points at the pasted copy; a link out of it is dropped');
check(copied.teleporters[0].destinations.length === 0, 'a teleporter copied without its partner loses that link');
check(copied.blocks.length === 1, 'blocks are copied too');
const back = fromClipboardText(toClipboardText(copied));
const canon = (g) => JSON.stringify(Object.keys(g).sort().map((k) => [k, g[k]]));
check(back && canon(back) === canon(copied), 'clipboard text round-trips');
check(fromClipboardText('hello') === null && fromClipboardText('{"format":"other"}') === null, 'foreign clipboard text is ignored');
const before = doc.navNodes.length;
insert(doc, remapIds(copied));
check(doc.navNodes.length === before + 2, 'paste inserts into the document');
removeSelection(doc, [{ kind: 'navNodes', id: n2.id }, { kind: 'teleporters', id: t2.id }]);
check(!n1.links.includes(n2.id) && !doc.teleporters.find((t) => t.id === t1.id).destinations.length, 'deleting removes links pointing at the deleted items');
const c = centreOf({ navNodes: [{ position: { x: 0, y: 0, z: 0 } }, { position: { x: 4, y: 2, z: -2 } }] });
check(c.x === 2 && c.y === 1 && c.z === -1, 'centre of a selection');

console.log(failures ? `${failures}/${checks} FAILED` : `all ${checks} checks passed`);
process.exit(failures ? 1 : 0);
