// Round trip: read an official map, write it with our writer, read the result back, and compare.
// Also hands the written file to the custom server's own parser (an independent implementation)
// and builds its physics world, so a layout mistake can't hide behind a symmetric reader bug.
//   node tests/test_roundtrip.js <map.evmap> [path/to/EV.IO-Custom-Server]
import fs from 'fs';
import { createRequire } from 'module';
import { readEvmap, writeEvmap } from '../src/evmap/format.js';

const [file, serverDir = (process.env.EVIO_SERVER_DIR || new URL('../../EV.IO-Custom-Server', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))] = process.argv.slice(2);
let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log('FAIL', msg); } };
const toAB = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const original = readEvmap(toAB(fs.readFileSync(file)));
// Our writer emits plain materials and simple weapon spawns; convert the Ex forms the official map uses.
const src = {
    ...original,
    materials: original.materials || original.materialsEx.map((e) => e.material || { color: { r: 1, g: 1, b: 1 }, colorAlpha: 1 }),
    weaponSpawns: original.weaponSpawns || original.weaponSpawnsEx.map((s) => s.position),
};
const bytes = writeEvmap(src);
const back = readEvmap(bytes.buffer.slice(0, bytes.length));

check(back.bytesRead === back.bytesTotal, `re-read consumed ${back.bytesRead}/${back.bytesTotal} bytes`);
check(back.meshes.length === original.meshes.length, 'mesh count');
let maxErr = 0, triMismatch = 0;
original.meshes.forEach((m, i) => {
    const b = back.meshes[i];
    const span = Math.max(...[0, 1, 2].map((a) => {
        let lo = Infinity, hi = -Infinity;
        for (let k = a; k < m.vertexBuffer.length; k += 3) { lo = Math.min(lo, m.vertexBuffer[k]); hi = Math.max(hi, m.vertexBuffer[k]); }
        return hi - lo;
    }));
    for (let k = 0; k < m.vertexBuffer.length; k++) maxErr = Math.max(maxErr, Math.abs(m.vertexBuffer[k] - b.vertexBuffer[k]) / Math.max(span, 1e-6));
    m.submeshes.forEach((s, j) => { if (s.indexBuffer.join() !== b.submeshes[j].indexBuffer.join()) triMismatch++; });
});
check(maxErr < 2 / 65535, `vertex re-quantisation error ${maxErr} (relative to mesh span)`);
check(triMismatch === 0, `${triMismatch} index buffers differ`);
const countNodes = (n) => 1 + n.children.reduce((s, c) => s + countNodes(c), 0);
check(countNodes(back.rootObject) === countNodes(original.rootObject), 'node count');
check(back.playerSpawns.length === original.playerSpawns.length, 'player spawn count');
check(back.playerSpawns.every((s, i) => near(s.position.w, original.playerSpawns[i].position.w, 1e-3)), 'spawn yaw');
check(back.directionalLights.length === original.directionalLights.length, 'light count');
check(back.directionalLights.every((l, i) => l.features === original.directionalLights[i].features), 'light flags');
check(back.aiNavNodes.length === original.aiNavNodes.length, 'nav node count');
check(back.cameraPaths.length === original.cameraPaths.length, 'camera path count');
check(near(back.fogDensity, original.fogDensity, 1e-7), 'fog density');
check(back.cameraFarPlane === original.cameraFarPlane, 'far plane');

// Independent parser: the custom server's physics_world.js.
const require = createRequire(import.meta.url);
const bpw = require(`${serverDir}/physics_world.js`);
const geo = bpw.parseEvmapBuffer(Buffer.from(bytes), 'roundtrip');
const ref = bpw.parseEvmapBuffer(fs.readFileSync(file), 'original');
check(geo.vertices.length === ref.vertices.length, `server parser: collision vertices ${geo.vertices.length} vs ${ref.vertices.length}`);
check(geo.indices.length === ref.indices.length, `server parser: collision indices ${geo.indices.length} vs ${ref.indices.length}`);
check(geo.spawns.length === ref.spawns.length, 'server parser: spawns');
const world = bpw.buildWorldFromEvmapBuffer(Buffer.from(bytes), 'roundtrip');
check(!!world.world, 'server physics world builds');

console.log(`${file.split(/[\\/]/).pop()}: ${original.bytesTotal} -> ${bytes.length} bytes, max vertex error ${maxErr.toExponential(2)}, collision tris ${geo.indices.length / 3}`);
console.log(failures ? `${failures} FAILED` : 'round trip OK');
process.exit(failures ? 1 : 0);
