// Compile a document built in code, write it, and check the result the way the game would see it.
//   node tests/test_compile.js [path/to/EV.IO-Custom-Server]
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { newDocument, newId, COLLISION, validate } from '../src/model/document.js';
import { compileDocument, cameraNodeRotation, cameraForward } from '../src/model/compile.js';
import { buildBlockTriangles, SHAPES } from '../src/model/geometry.js';
import { writeEvmap, readEvmap, NODE } from '../src/evmap/format.js';

const serverDir = process.argv[2] || (process.env.EVIO_SERVER_DIR || new URL('../../EV.IO-Custom-Server', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
let failures = 0, checks = 0;
const check = (ok, msg) => { checks++; if (!ok) { failures++; console.log('FAIL', msg); } };

// 1. Every shape's faces point outward (convex shapes: normal . (corner - centre) > 0).
for (const shape of SHAPES) {
    if (shape === 'stairs') continue;   // a union of boxes: checked per step below
    for (const rotation of [{ x: 0, y: 0, z: 0 }, { x: 30, y: 45, z: 10 }]) {
        const block = { shape, position: { x: 3, y: 2, z: -1 }, rotation, size: { x: 4, y: 2, z: 6 } };
        const { positions, normals } = buildBlockTriangles(block);
        // Interior reference point: the mean of the distinct corners (strictly inside a convex
        // solid; the bounding-box centre is not — a ramp's slope passes right through it).
        const corners = new Map();
        for (let i = 0; i < positions.length; i += 3) corners.set(positions.slice(i, i + 3).map((v) => v.toFixed(5)).join(), positions.slice(i, i + 3));
        const inside = [0, 1, 2].map((k) => [...corners.values()].reduce((s, p) => s + p[k], 0) / corners.size);
        let bad = 0;
        for (let i = 0; i < positions.length; i += 9) {
            // triangle winding matches its normal
            const a = positions.slice(i, i + 3), b = positions.slice(i + 3, i + 6), c = positions.slice(i + 6, i + 9);
            const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            const n = normals.slice(i, i + 3);
            const centroid = [0, 1, 2].map((k) => (a[k] + b[k] + c[k]) / 3 - inside[k]);
            if (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] <= 0) bad++;
            if (centroid[0] * n[0] + centroid[1] * n[1] + centroid[2] * n[2] <= 0) bad++;
        }
        check(bad === 0, `${shape} rot ${JSON.stringify(rotation)}: ${bad} faces inward or mis-wound`);
    }
}
{
    const { positions, normals } = buildBlockTriangles({ shape: 'stairs', steps: 5, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 2, z: 5 } });
    let bad = 0;
    for (let i = 0; i < positions.length; i += 9) {
        const a = positions.slice(i, i + 3), b = positions.slice(i + 3, i + 6), c = positions.slice(i + 6, i + 9);
        const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        if (cr[0] * normals[i] + cr[1] * normals[i + 1] + cr[2] * normals[i + 2] <= 0) bad++;
    }
    check(bad === 0, `stairs: ${bad} mis-wound triangles`);
}

// 2. Camera node rotation: q * (0,0,1), mirrored in x, must be the game-space forward.
for (const [yaw, pitch] of [[0, 0], [90, -20], [215, 35], [359, -60]]) {
    const q = cameraNodeRotation(yaw, pitch);
    const v = { x: 0, y: 0, z: 1 };
    // rotate v by q
    const ix = q.w * v.x + q.y * v.z - q.z * v.y, iy = q.w * v.y + q.z * v.x - q.x * v.z, iz = q.w * v.z + q.x * v.y - q.y * v.x, iw = -q.x * v.x - q.y * v.y - q.z * v.z;
    const r = { x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y, y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z, z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x };
    const f = cameraForward(yaw, pitch);
    const err = Math.hypot(-r.x - f.x, r.y - f.y, r.z - f.z);
    check(err < 1e-6, `camera node yaw ${yaw} pitch ${pitch}: forward error ${err}`);
}

// 3. A small arena: floor, walls, a ramp, stairs, a platform, an invisible wall and a visual-only pillar.
const doc = newDocument('Test arena');
const blk = (shape, position, size, extra = {}) => doc.blocks.push({ id: newId('blk'), shape, position, rotation: { x: 0, y: 0, z: 0 }, size, materialId: 'mat_concrete', collision: COLLISION.SOLID, shadows: true, ...extra });
blk('box', { x: 0, y: 2, z: 30 }, { x: 60, y: 4, z: 1 });
blk('box', { x: 0, y: 2, z: -30 }, { x: 60, y: 4, z: 1 });
blk('ramp', { x: 10, y: 1, z: 0 }, { x: 4, y: 2, z: 8 }, { materialId: 'mat_sand' });
blk('stairs', { x: -10, y: 1.5, z: 0 }, { x: 3, y: 3, z: 6 }, { steps: 6, materialId: 'mat_wood' });
blk('box', { x: 0, y: 4, z: 15 }, { x: 10, y: 0.5, z: 6 }, { materialId: 'mat_metal' });
blk('box', { x: 0, y: 5, z: -29 }, { x: 60, y: 10, z: 0.2 }, { collision: COLLISION.INVISIBLE });
blk('cylinder', { x: 20, y: 3, z: 20 }, { x: 2, y: 6, z: 2 }, { collision: COLLISION.VISUAL });
doc.weaponSpawns.push({ id: newId('wpn'), position: { x: 0, y: 0.5, z: 0 } });
const a = { id: newId('tp'), position: { x: -25, y: 0.1, z: -25 }, yaw: 0, radius: 1.5, destinations: [] };
const b = { id: newId('tp'), position: { x: 25, y: 0.1, z: 25 }, yaw: 180, radius: 1.5, destinations: [] };
a.destinations = [b.id]; b.destinations = [a.id];
doc.teleporters.push(a, b);
const n1 = { id: newId('nav'), position: { x: -20, y: 0.1, z: 0 }, links: [] }, n2 = { id: newId('nav'), position: { x: 20, y: 0.1, z: 0 }, links: [] };
n1.links = [n2.id];
doc.navNodes.push(n1, n2);
doc.cameraPaths.push({ id: newId('cam'), start: { position: { x: -30, y: 15, z: -30 }, yaw: 225, pitch: -20 }, end: { position: { x: 30, y: 15, z: -30 }, yaw: 135, pitch: -20 }, seconds: 25 });

const issues = validate(doc);
check(!issues.some((i) => i.level === 'error'), `validator errors: ${JSON.stringify(issues)}`);

const compiled = compileDocument(doc);
const bytes = writeEvmap(compiled);
const back = readEvmap(bytes.buffer.slice(0, bytes.length));
check(back.bytesRead === back.bytesTotal, `re-read ${back.bytesRead}/${back.bytesTotal} bytes`);
check(back.playerSpawns.length === 2 && back.teleporters.length === 2 && back.aiNavNodes.length === 2 && back.cameraPaths.length === 1, 'gameplay objects survive');
check(back.teleporters[0].destinationIndices[0] === 1 && back.teleporters[1].destinationIndices[0] === 0, 'teleporter links resolve to indices');
check(back.directionalLights.filter((l) => l.features & 1).length === 1, 'exactly one shadow-casting light');
const feats = back.rootObject.children.map((c) => c.features);
check(feats.includes(NODE.COLLISION), 'invisible wall exported as collision-only node');
check(feats.includes(NODE.RENDER | NODE.SHADOWS), 'visual-only pillar exported without collision');
check(feats.some((f) => (f & NODE.RENDER) && (f & NODE.COLLISION)), 'solid blocks render and collide');

// File-space winding, as the client and Bishop have it.
let agree = 0, against = 0;
for (const m of back.meshes) {
    const v = m.vertexBuffer, nb = m.normalBuffer;
    for (const s of m.submeshes) for (let i = 0; i < s.indexBuffer.length; i += 3) {
        const [p, q, r] = [s.indexBuffer[i], s.indexBuffer[i + 1], s.indexBuffer[i + 2]];
        const e1 = [v[q * 3] - v[p * 3], v[q * 3 + 1] - v[p * 3 + 1], v[q * 3 + 2] - v[p * 3 + 2]], e2 = [v[r * 3] - v[p * 3], v[r * 3 + 1] - v[p * 3 + 1], v[r * 3 + 2] - v[p * 3 + 2]];
        const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const d = cr[0] * nb[p * 3] + cr[1] * nb[p * 3 + 1] + cr[2] * nb[p * 3 + 2];
        d > 0 ? agree++ : against++;
    }
}
check(against === 0, `file-space winding: ${agree} agree, ${against} against`);

// 4. The custom server parses it and builds physics; spawns resolve onto the floor.
const require = createRequire(import.meta.url);
const bpw = require(`${serverDir}/physics_world.js`);
const geo = bpw.parseEvmapBuffer(Buffer.from(bytes), 'test-arena');
const solidTris = doc.blocks.filter((b) => b.collision !== COLLISION.VISUAL).reduce((s, b) => s + buildBlockTriangles(b).positions.length / 9, 0);
check(geo.indices.length / 3 === solidTris, `server collision triangles ${geo.indices.length / 3}, expected ${solidTris}`);
const built = bpw.buildWorldFromEvmapBuffer(Buffer.from(bytes), 'test-arena');
check(!!built.world, 'server physics world builds');
check(built.spawns.length === 2, 'server sees 2 spawns');
// Spawn positions come back mirrored to game space by the server: (-20, *, 0) and (20, *, 0).
const sx = built.spawns.map((s) => Math.round(s.x ?? s.Qdsukt4?.x ?? NaN)).sort((p, q) => p - q);
check(JSON.stringify(sx) === JSON.stringify([-20, 20]) || JSON.stringify(sx) === JSON.stringify([20, -20].sort((p, q) => p - q)), `spawn x after load: ${JSON.stringify(built.spawns.slice(0, 2))}`);

const out = path.join(os.tmpdir(), 'evmap-editor-test-arena.evmap');
fs.writeFileSync(out, bytes);
console.log(`test arena: ${bytes.length} bytes, ${back.meshes.length} meshes, ${back.rootObject.children.length} nodes, ${geo.indices.length / 3} collision tris -> ${out}`);
console.log(failures ? `${failures}/${checks} FAILED` : `all ${checks} checks passed`);
process.exit(failures ? 1 : 0);
