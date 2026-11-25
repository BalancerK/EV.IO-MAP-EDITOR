// Drives the editor in headless Chrome over the DevTools protocol with real mouse events, then
// checks the exported bytes with the Node reader and the custom server's parser.
//   1. serve the repo:   python -m http.server 8765 --bind 127.0.0.1
//   2. run:              node tests/browser_smoke.js [chrome.exe] [screenshot.png]
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { readEvmap } from '../src/evmap/format.js';

const chrome = process.argv[2] || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const shot = process.argv[3] || path.join(os.tmpdir(), 'evio-map-editor-smoke.png');
const serverDir = (process.env.EVIO_SERVER_DIR || new URL('../../EV.IO-Custom-Server', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const URL_ = 'http://127.0.0.1:8765/';
const PORT = 9333;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'evio-map-editor-prof-'));
const proc = spawn(chrome, ['--headless=new', '--no-first-run', '--disable-extensions', `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok, msg) => { console.log(ok ? 'ok  ' : 'FAIL', msg); if (!ok) failures++; };

async function main() {
    let targets;
    for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(250); } }
    const page = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    let seq = 0;
    const pending = new Map();
    const errors = [];
    ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
        if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    });
    const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate failed');
        return r.result.result.value;
    };
    const click = async (x, y) => {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        await sleep(150);
    };
    const doc = () => evaluate(`JSON.parse(localStorage.getItem('evio-map-editor:doc'))`);
    const press = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: URL_ });
    await sleep(4000);

    const start = await doc();
    check(start && start.blocks.length === 1, 'fresh map has the default floor');

    // Viewport centre (the default camera looks at the origin, which is floor).
    const vp = await evaluate(`(() => { const r = document.querySelector('#viewport').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);

    await press('[data-key="b:Box"]');
    await click(vp.x, vp.y);
    let d = await doc();
    check(d.blocks.length === 2, `placing a box adds a block (${d.blocks.length})`);
    const box = d.blocks[1];
    check(box && Math.abs(box.position.y - 2) < 1e-6, `box sits on the floor (centre y ${box?.position.y}, expected 2)`);

    await press('[data-key="o:Nav node"]');
    await click(vp.x - 150, vp.y + 60);
    await click(vp.x + 150, vp.y + 60);
    d = await doc();
    check(d.navNodes.length === 2 && d.navNodes[0].links.includes(d.navNodes[1].id), 'second nav node links to the first');

    await press('[data-key="o:Teleporter"]');
    await click(vp.x - 200, vp.y + 120);
    await click(vp.x + 200, vp.y + 120);
    d = await doc();
    check(d.teleporters.length === 2 && d.teleporters[0].destinations[0] === d.teleporters[1].id && d.teleporters[1].destinations[0] === d.teleporters[0].id, 'consecutive teleporters pair both ways');

    // Select mode, click the box, check the inspector shows it.
    await press('[data-tool="select"]');
    // Deselect first: the selected teleporter's move gizmo would otherwise sit over the box.
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    const cleared = await evaluate(`document.querySelector('#inspector h3')?.textContent || ''`);
    check(cleared === 'Shortcuts', `Escape clears the selection (inspector: "${cleared}")`);
    await click(vp.x, vp.y - 10);
    const heading = await evaluate(`document.querySelector('#inspector h3')?.textContent || ''`);
    check(/Box/.test(heading), `clicking the box selects it (inspector: "${heading}")`);

    // Undo removes the last teleporter.
    await press('#btn-undo');
    d = await doc();
    check(d.teleporters.length === 1, `undo removes the last placed teleporter (${d.teleporters.length})`);
    await press('#btn-redo');
    d = await doc();
    check(d.teleporters.length === 2, 'redo restores it');

    await press('#btn-export');
    await sleep(300);
    const exportText = await evaluate(`document.querySelector('#export-body').innerText`);
    check(/File size/.test(exportText) && !(await evaluate(`document.querySelector('#export-download').disabled`)), 'export dialog shows stats and can download');

    // The bytes the page would download, checked outside the browser.
    const b64 = await evaluate(`(async () => {
        const { compileDocument } = await import('/src/model/compile.js');
        const { writeEvmap } = await import('/src/evmap/format.js');
        const bytes = writeEvmap(compileDocument(JSON.parse(localStorage.getItem('evio-map-editor:doc'))));
        let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s);
    })()`);
    const bytes = Buffer.from(b64, 'base64');
    const m = readEvmap(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    check(m.bytesRead === m.bytesTotal, `browser export re-reads exactly (${bytes.length} bytes)`);
    check(m.teleporters.length === 2 && m.aiNavNodes.length === 2, 'teleporters and nav nodes exported');
    const require = createRequire(import.meta.url);
    const bpw = require(`${serverDir}/physics_world.js`);
    const built = bpw.buildWorldFromEvmapBuffer(bytes, 'smoke');
    check(!!built.world && built.spawns.length === 2, 'server builds a physics world from the browser export');

    const img = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shot, Buffer.from(img.result.data, 'base64'));
    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
    console.log('screenshot:', shot);
    ws.close();
}

main().catch((e) => { console.error(e); failures++; }).finally(() => {
    proc.kill();
    console.log(failures ? `${failures} FAILED` : 'browser smoke test passed');
    process.exit(failures ? 1 : 0);
});
