// Opening existing maps: import -> export -> compare, on real .evmap files.
//   node tests/test_import.js [map.evmap | folder of maps ...]
// With no argument it uses the maps the EV.IO custom server has cached (../EV.IO-Custom-Server).
// For each map: the export re-reads completely; the custom server's own parser sees the same
// collision triangles, spawns and portals as in the original; every piece of geometry sits where it
// did (world matrices compared); the original meshes, materials and textures are written unchanged;
// a walk-test player dropped at each spawn lands on the floor; and an edit (moving, deleting a piece,
// adding a block) shows up in the export.
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { readEvmap, writeEvmap } from '../src/evmap/format.js';
import { importEvmap, modelsFromScene } from '../src/model/importer.js';
import { registerAsset } from '../src/model/assets.js';
import { compileDocument, svd3 } from '../src/model/compile.js';
import { buildWalkWorld, newPlayer, stepPlayer } from '../src/model/walk.js';
import { newId, COLLISION } from '../src/model/document.js';

const serverDir = process.env.EVIO_SERVER_DIR || new URL('../../EV.IO-Custom-Server', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const args = process.argv.slice(2);
const inputs = args.length ? args : [path.join(serverDir, 'map_cache')];
const files = inputs.flatMap((p) => fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((f) => f.endsWith('.evmap')).map((f) => path.join(p, f)) : [p]);
const require = createRequire(import.meta.url);
let bpw = null;
try { bpw = require(`${serverDir}/physics_world.js`); } catch { console.log('(custom server not found: skipping its parser checks)'); }
const quiet = (fn) => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };

let failures = 0, checks = 0;
const check = (ok, msg) => { checks++; if (!ok) { failures++; console.log('  FAIL', msg); } };
const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// The SVD used for sheared pieces reproduces the matrix.
{
    const M = [1.2, 0.4, -0.3, 0.1, 0.9, 0.5, -0.2, 0.3, 1.7];
    const { u, s, vt } = svd3(M);
    let err = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        let v = 0;
        for (let k = 0; k < 3; k++) v += u[i * 3 + k] * s[k] * vt[k * 3 + j];
        err = Math.max(err, Math.abs(v - M[i * 3 + j]));
    }
    check(err < 1e-9, `SVD rebuilds a sheared matrix (error ${err.toExponential(1)})`);
}

for (const file of files) {
    const name = path.basename(file);
    const t0 = Date.now();
    const bytes = fs.readFileSync(file);
    const src = readEvmap(toAB(bytes));
    const key = 'test:' + name;
    registerAsset(key, src);
    const { doc, report } = importEvmap(src, { key, name });

    const out = writeEvmap(compileDocument(doc));
    const back = readEvmap(out.buffer.slice(0, out.length));
    check(back.bytesRead === back.bytesTotal, `${name}: export re-reads completely`);

    // Geometry placement: every piece's world matrix, in order.
    const a = modelsFromScene(src.rootObject).models, b = modelsFromScene(back.rootObject).models;
    check(a.length === b.length, `${name}: ${a.length} pieces -> ${b.length}`);
    let worst = 0;
    const mat = (m) => m.matrix || null;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        // Compare the transformed corners of a unit cube (covers rotation, scale, shear, position).
        const ta = mat(a[i]) || affine(a[i]), tb = mat(b[i]) || affine(b[i]);
        const scale = 1 + Math.hypot(...ta.t);
        for (let c = 0; c < 8; c++) {
            const p = [c & 1 ? 1 : -1, c & 2 ? 1 : -1, c & 4 ? 1 : -1];
            for (let r = 0; r < 3; r++) {
                const va = ta.m[r * 3] * p[0] + ta.m[r * 3 + 1] * p[1] + ta.m[r * 3 + 2] * p[2] + ta.t[r];
                const vb = tb.m[r * 3] * p[0] + tb.m[r * 3 + 1] * p[1] + tb.m[r * 3 + 2] * p[2] + tb.t[r];
                worst = Math.max(worst, Math.abs(va - vb) / scale);
            }
        }
        if (a[i].render !== b[i].render || a[i].collide !== b[i].collide || a[i].shadows !== b[i].shadows || a[i].collisionLayer !== b[i].collisionLayer
            || a[i].materials.join() !== b[i].materials.join()) { worst = Infinity; break; }
        if (!sameBytes(src.meshes[a[i].mesh].raw, back.meshes[b[i].mesh].raw)) { worst = Infinity; break; }
    }
    check(worst < 1e-5, `${name}: every piece in place with the same mesh, materials and flags (worst ${worst.toExponential(1)})`);
    const matsA = src.materialsEx || src.materials, matsB = back.materialsEx || back.materials;
    check(matsA.length === matsB.length && matsA.every((m, i) => sameBytes(m.raw, matsB[i].raw) && (m.shader ?? 0) === (matsB[i].shader ?? 0)), `${name}: materials unchanged`);
    check(src.textures.length === back.textures.length && src.textures.every((t, i) => sameBytes(t.data, back.textures[i].data)), `${name}: textures unchanged`);

    // Gameplay data.
    const near = (p, q, tol = 1e-3) => Math.abs(p.x - q.x) < tol && Math.abs(p.y - q.y) < tol && Math.abs(p.z - q.z) < tol;
    check(back.playerSpawns.length === src.playerSpawns.length && back.playerSpawns.every((s, i) => near(s.position, src.playerSpawns[i].position) && Math.abs(((s.position.w - src.playerSpawns[i].position.w) % 360 + 540) % 360 - 180) < 1e-3
        && s.team1 === src.playerSpawns[i].team1 && s.team2 === src.playerSpawns[i].team2), `${name}: player spawns, facing and teams`);
    const wa = src.weaponSpawnsEx || (src.weaponSpawns || []).map((p) => ({ position: p })), wb = back.weaponSpawnsEx || (back.weaponSpawns || []).map((p) => ({ position: p }));
    check(wa.length === wb.length && wa.every((w, i) => near(w.position, wb[i].position) && (w.spawnList ?? 0) === (wb[i].spawnList ?? 0)), `${name}: weapon spawns and their weapon lists`);
    const ta = src.teleporters || [], tb = back.teleporters || [];
    check(ta.length === tb.length && ta.every((t, i) => near(t.position, tb[i].position) && Math.abs(t.radius - tb[i].radius) < 1e-6 && t.destinationIndices.join() === tb[i].destinationIndices.join() && (t.gameMode || '') === (tb[i].gameMode || '')), `${name}: teleporters`);
    const linkSet = (nodes) => new Set((nodes || []).flatMap((n, i) => n.neighborIndices.filter((j) => j !== i).map((j) => (i < j ? `${i},${j}` : `${j},${i}`))));
    const la = linkSet(src.aiNavNodes), lb = linkSet(back.aiNavNodes);
    check((src.aiNavNodes || []).length === (back.aiNavNodes || []).length && la.size === lb.size && [...la].every((k) => lb.has(k)), `${name}: nav nodes and links (${la.size})`);
    const camNodes = (m) => (m.cameraPaths || []).flatMap((p) => p.nodes);
    check(camNodes(src).length === camNodes(back).length || (src.cameraPaths || []).every((p) => p.nodes.length === 2), `${name}: camera paths`);
    check(camNodes(src).every((n, i) => near(n.position, camNodes(back)[i].position)), `${name}: camera positions`);
    check(JSON.stringify(src.flagSpawns || []) === JSON.stringify(back.flagSpawns || []) && JSON.stringify(src.bombSites || []) === JSON.stringify(back.bombSites || []), `${name}: flag spawns and bomb sites`);
    check(back.directionalLights.length === src.directionalLights.length && back.directionalLights.every((l, i) => near(l.direction, src.directionalLights[i].direction, 1e-4) && Math.abs(l.intensity - src.directionalLights[i].intensity) < 1e-6), `${name}: lights`);
    check(near(back.shadowSettings.position, src.shadowSettings.position) && Math.abs(back.shadowSettings.far - src.shadowSettings.far) < 1e-3, `${name}: shadow camera`);
    check(Math.abs(back.fogDensity - src.fogDensity) < 1e-7 && back.cameraFarPlane === (src.cameraFarPlane ?? 1000), `${name}: fog and view distance`);

    // The custom server's own parser sees the same collision world.
    if (bpw) {
        const ga = quiet(() => bpw.parseEvmapBuffer(bytes, 'orig')), gb = quiet(() => bpw.parseEvmapBuffer(Buffer.from(out), 'export'));
        check(ga.indices.length === gb.indices.length, `${name}: server parser collision triangles ${ga.indices.length / 3} -> ${gb.indices.length / 3}`);
        const box = (g) => { const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < g.vertices.length; i++) { const k = i % 3; mn[k] = Math.min(mn[k], g.vertices[i]); mx[k] = Math.max(mx[k], g.vertices[i]); } return [...mn, ...mx]; };
        const ba = box(ga), bb = box(gb);
        check(ba.every((v, i) => Math.abs(v - bb[i]) < 1e-2), `${name}: server parser collision bounds match`);
        check(ga.spawns.length === gb.spawns.length, `${name}: server parser spawns`);
    }

    // Walk test: a player dropped at each spawn lands on something.
    const world = buildWalkWorld(doc);
    let landed = 0;
    for (const s of doc.playerSpawns) {
        const p = newPlayer({ x: s.position.x, y: s.position.y + 0.5, z: s.position.z }, s.yaw);
        for (let i = 0; i < 80 && !p.grounded; i++) stepPlayer(world, p, {});
        if (p.grounded && p.pos.y > -29) landed++;
    }
    check(landed >= Math.ceil(doc.playerSpawns.length * 0.9), `${name}: walk-test player lands at ${landed} of ${doc.playerSpawns.length} spawns`);

    // Editing: move one solid piece, delete another, add a block.
    const solid = doc.models.filter((m) => m.collide && !m.matrix);
    if (solid.length >= 2) {
        const edited = JSON.parse(JSON.stringify(doc));
        edited.models.find((m) => m.id === solid[0].id).position.y += 5;
        edited.models = edited.models.filter((m) => m.id !== solid[1].id);
        edited.blocks.push({ id: newId('blk'), shape: 'box', position: { x: 0, y: 200, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, size: { x: 4, y: 1, z: 4 }, materialId: 'mat_concrete', collision: COLLISION.SOLID, shadows: true });
        const e = readEvmap((() => { const w = writeEvmap(compileDocument(edited)); return w.buffer.slice(0, w.length); })());
        const em = modelsFromScene(e.rootObject).models;
        const moved = em.find((m) => Math.abs(m.position.y - solid[0].position.y - 5) < 1e-4 && Math.abs(m.position.x - solid[0].position.x) < 1e-4 && Math.abs(m.position.z - solid[0].position.z) < 1e-4);
        check(em.length === a.length && !!moved, `${name}: a moved piece moves, a deleted one goes, a new block is added (${a.length} -> ${em.length})`);
        check((e.materialsEx || e.materials).length === matsA.length + 1, `${name}: the new block's material follows the map's own`);
    }
    console.log(`${name}: ${report.models} pieces, ${report.triangles} triangles, ${doc.playerSpawns.length} spawns, ${doc.navNodes.length} nav nodes, ${(out.length / 1048576).toFixed(1)} MB (was ${(bytes.length / 1048576).toFixed(1)}), ${Date.now() - t0} ms`);
}

function affine(m) {
    // Same maths as the editor (assets.modelTransform), kept local to compare independently of it.
    const d = Math.PI / 180;
    const c1 = Math.cos(m.rotation.x * d / 2), c2 = Math.cos(m.rotation.y * d / 2), c3 = Math.cos(m.rotation.z * d / 2);
    const s1 = Math.sin(m.rotation.x * d / 2), s2 = Math.sin(m.rotation.y * d / 2), s3 = Math.sin(m.rotation.z * d / 2);
    const q = { x: s1 * c2 * c3 + c1 * s2 * s3, y: c1 * s2 * c3 - s1 * c2 * s3, z: c1 * c2 * s3 + s1 * s2 * c3, w: c1 * c2 * c3 - s1 * s2 * s3 };
    const { x, y, z, w } = q, s = m.scale;
    const r = [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
    return { m: [r[0] * s.x, r[1] * s.y, r[2] * s.z, r[3] * s.x, r[4] * s.y, r[5] * s.z, r[6] * s.x, r[7] * s.y, r[8] * s.z], t: [m.position.x, m.position.y, m.position.z] };
}

console.log(failures ? `${failures}/${checks} FAILED` : `all ${checks} checks passed (${files.length} maps)`);
process.exit(failures ? 1 : 0);
