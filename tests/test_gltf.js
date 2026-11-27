// .evmap -> glTF: converts official maps and an editor-built map, and checks the result.
//   node tests/test_gltf.js [path/to/EV.IO-Custom-Server]   (official maps come from its map_cache)
// With OUT=dir set, the .glb files are also written there (e.g. for the Khronos glTF validator).
import fs from 'fs';
import path from 'path';
import { readEvmap, NODE } from '../src/evmap/format.js';
import { evmapToGltf, evmapToGlb, evmapToGltfFile } from '../src/evmap/gltf.js';
import { newDocument, newId } from '../src/model/document.js';
import { compileDocument } from '../src/model/compile.js';

const serverDir = process.argv[2] || (process.env.EVIO_SERVER_DIR || new URL('../../EV.IO-Custom-Server', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
let failures = 0, checks = 0;
const check = (ok, msg) => { checks++; if (!ok) { failures++; console.log('FAIL', msg); } };

function parseGlb(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    check(dv.getUint32(0, true) === 0x46546c67, 'glb magic');
    check(dv.getUint32(8, true) === bytes.length, 'glb length matches the header');
    const jl = dv.getUint32(12, true);
    check(jl % 4 === 0, 'json chunk is 4-byte aligned');
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jl)));
    const bl = 20 + jl < bytes.length ? dv.getUint32(20 + jl, true) : 0;
    return { json, bin: bl ? bytes.subarray(28 + jl, 28 + jl + bl) : null };
}

function checkMap(label, m) {
    const { bytes, stats } = evmapToGlb(m, { name: label });
    const { json, bin } = parseGlb(bytes);
    // Every accessor fits its buffer view, every index is in range.
    for (const [i, a] of json.accessors.entries()) {
        const v = json.bufferViews[a.bufferView];
        const size = { SCALAR: 1, VEC2: 2, VEC3: 3 }[a.type] * (a.componentType === 5123 ? 2 : 4);
        check(a.count * size <= v.byteLength, `${label}: accessor ${i} fits its view`);
        check(v.byteOffset % 4 === 0, `${label}: view ${a.bufferView} aligned`);
    }
    for (const mesh of json.meshes) for (const p of mesh.primitives) {
        const ia = json.accessors[p.indices], v = json.bufferViews[ia.bufferView];
        const n = json.accessors[p.attributes.POSITION].count;
        const arr = ia.componentType === 5123 ? new Uint16Array(bin.buffer, bin.byteOffset + v.byteOffset, ia.count) : new Uint32Array(bin.buffer, bin.byteOffset + v.byteOffset, ia.count);
        let bad = 0; for (const x of arr) if (x >= n) bad++;
        check(bad === 0, `${label}: ${mesh.name} indices in range`);
        check(p.material < json.materials.length, `${label}: material index in range`);
    }
    // Rendered pieces in the file = mesh nodes in the Map group.
    let rendered = 0;
    const walk = (n) => { if ((n.features & NODE.RENDER) && n.targetObjectIndex !== undefined && m.meshes[n.targetObjectIndex]?.vertexBuffer.length) rendered++; (n.children || []).forEach(walk); };
    walk(m.rootObject);
    check(stats.pieces === rendered, `${label}: ${stats.pieces} pieces exported vs ${rendered} rendered in the file`);
    // Game space: positions are the file's mirrored in x.
    const pos = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
    check(pos.min.length === 3 && pos.min.every(Number.isFinite), `${label}: position bounds finite`);
    console.log(`${label}: ${stats.pieces} pieces, ${stats.meshes} meshes, ${stats.materials} materials, ${stats.textures} textures, ${(bytes.length / 1048576).toFixed(2)} MB`);
    if (process.env.OUT) fs.writeFileSync(path.join(process.env.OUT, `${label}.glb`), bytes);
    // The .gltf text form carries the same buffer, embedded as base64.
    const text = evmapToGltfFile(m, { name: label }).bytes;
    const g = JSON.parse(new TextDecoder().decode(text));
    const data = Buffer.from(g.buffers[0].uri.split(',')[1], 'base64');
    check(data.length === g.buffers[0].byteLength && data.equals(Buffer.from(bin)), `${label}: .gltf embeds the same buffer as the .glb`);
    if (process.env.OUT) fs.writeFileSync(path.join(process.env.OUT, `${label}.gltf`), text);
    return json;
}

// 1. Official maps.
const cache = path.join(serverDir, 'map_cache');
const files = fs.existsSync(cache) ? fs.readdirSync(cache).filter((f) => f.endsWith('.evmap')) : [];
if (!files.length) console.log(`(no official maps in ${cache}: skipped)`);
for (const f of files) {
    const b = fs.readFileSync(path.join(cache, f));
    checkMap(f.replace(/\.evmap$/, ''), readEvmap(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
}

// 2. A map built in the editor: one box, mirrored into game space.
{
    const doc = newDocument('glTF test');
    doc.blocks = [{ id: newId(), shape: 'box', position: { x: 10, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 2, z: 2 }, materialId: doc.materials[0].id, collision: 'solid' }];
    const m = compileDocument(doc);
    const { json } = evmapToGltf(m);
    const box = json.nodes.find((n) => n.mesh !== undefined);
    const a = json.accessors[json.meshes[box.mesh].primitives[0].attributes.POSITION];
    const t = box.matrix ? box.matrix.slice(12, 15) : [0, 0, 0];
    const cx = (a.min[0] + a.max[0]) / 2 + t[0];
    check(Math.abs(cx - 10) < 1e-3, `editor box stays at game x = 10 (got ${cx})`);
    check(json.scenes[0].nodes.length >= 1, 'scene has nodes');
}

console.log(`${checks} checks, ${failures} failed`);
process.exit(failures ? 1 : 0);
