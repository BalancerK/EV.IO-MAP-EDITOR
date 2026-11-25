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
        // confirm() dialogs (e.g. "replace your camera paths?"): accept.
        if (msg.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: ++seq, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
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

    // Camera paths: the two-shot framing flow with real keys and mouse, then generate, play, move.
    await evaluate(`document.querySelector('#export-dialog').close()`);
    const key = async (k, code, vk, holdMs = 0) => {
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk });
        if (holdMs) await sleep(holdMs);
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
        await sleep(120);
    };
    const rightDrag = async (x, y, dx, dy) => {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', clickCount: 1 });
        for (let i = 1; i <= 5; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (dx * i) / 5, y: y + (dy * i) / 5, button: 'right', buttons: 2 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'right', clickCount: 1 });
        await sleep(120);
    };
    const pathsBefore = (await doc()).cameraPaths.length;
    await press('[data-key="o:Camera"]');
    await sleep(200);
    const banner1 = await evaluate(`document.querySelector('#frame-banner').hidden ? '' : document.querySelector('#frame-label').textContent`);
    check(/START/.test(banner1), `Camera opens the framing banner for the start shot ("${banner1}")`);
    await key('w', 'KeyW', 87, 600);                 // fly forward
    await rightDrag(vp.x, vp.y, 120, 30);            // look right and down
    await key('Enter', 'Enter', 13);
    const banner2 = await evaluate(`document.querySelector('#frame-label').textContent`);
    check(/END/.test(banner2), `Enter saves the start and moves on to the end shot ("${banner2}")`);
    await key('d', 'KeyD', 68, 600);                 // strafe right
    await key('Enter', 'Enter', 13);
    d = await doc();
    const cam = d.cameraPaths[d.cameraPaths.length - 1];
    check(d.cameraPaths.length === pathsBefore + 1 && await evaluate(`document.querySelector('#frame-banner').hidden`), 'the second Enter creates the path and closes the banner');
    check(cam && Math.hypot(cam.end.position.x - cam.start.position.x, cam.end.position.z - cam.start.position.z) > 1, `the end shot is where the camera flew to (start ${JSON.stringify(cam?.start.position)}, end ${JSON.stringify(cam?.end.position)})`);
    check(cam && Math.abs(cam.start.pitch) > 1, `the mouse drag changed the shot's aim (pitch ${cam?.start.pitch})`);
    const keysLeak = await evaluate(`document.querySelector('[data-gizmo="translate"]').classList.contains('active')`);
    check(keysLeak, 'framing keys did not reach the editor shortcuts (W/E/R gizmo modes unchanged)');

    await press('[data-key="o:Auto paths"]');
    await sleep(300);
    d = await doc();
    check(d.cameraPaths.length === 6 && d.cameraPaths.every((c) => c.start.pitch < 0), `Auto paths makes 6 paths looking down at the map (${d.cameraPaths.length})`);
    await evaluate(`[...document.querySelectorAll('#inspector button')].find((b) => b.textContent === 'Play menu loop').click()`);
    await sleep(400);
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await evaluate(`[...document.querySelectorAll('#inspector button')].find((b) => b.textContent === 'Move').click()`);
    await sleep(150);
    const moveCard = await evaluate(`[...document.querySelectorAll('#inspector .card')].findIndex((c) => c.style.borderColor !== '')`);
    check(moveCard === 0, "Move selects that shot's marker for the gizmo");

    // Upload images: exact sizes and formats, real content (not a blank frame), view switching.
    await evaluate(`document.querySelector('#export-dialog').close()`);
    await press('#btn-images');
    await sleep(1500);
    const stills = await evaluate(`(async () => {
        const info = async (id) => {
            const img = document.querySelector(id);
            if (!img.complete || !img.naturalWidth) await new Promise((r) => img.addEventListener('load', r, { once: true }));
            const blob = await (await fetch(img.src)).blob();
            const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
            const g = c.getContext('2d'); g.drawImage(img, 0, 0);
            const d = g.getImageData(0, 0, c.width, c.height).data;
            const seen = new Set(); for (let i = 0; i < d.length; i += 4 * 97) seen.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3));
            return { w: img.naturalWidth, h: img.naturalHeight, type: blob.type, bytes: blob.size, colours: seen.size };
        };
        return { large: await info('#large-preview'), thumb: await info('#thumb-preview') };
    })()`);
    check(stills.large.w === 2000 && stills.large.h === 902 && stills.large.type === 'image/jpeg', `large image is 2000x902 JPEG (${JSON.stringify(stills.large)})`);
    check(stills.thumb.w === 166 && stills.thumb.h === 70 && stills.thumb.type === 'image/png', `thumbnail is 166x70 PNG (${JSON.stringify(stills.thumb)})`);
    // Toon shading has few tones and a simple test map is mostly sky: require more than a blank frame.
    check(stills.large.colours > 10 && stills.thumb.colours >= 3, 'both images show the map, not a blank frame');
    const firstSrc = await evaluate(`document.querySelector('#large-preview').src`);
    await evaluate(`(() => { const s = document.querySelector('#images-view'); s.value = 'view'; s.dispatchEvent(new Event('change')); })()`);
    let rerendered = false;
    for (let i = 0; i < 40 && !rerendered; i++) { await sleep(250); rerendered = (await evaluate(`document.querySelector('#large-preview').src`)) !== firstSrc; }
    check(rerendered, 'changing the view re-renders the images');
    const stillShot = path.join(path.dirname(shot), 'evio-map-editor-large.jpg');
    const largeB64 = await evaluate(`(async () => { const b = await (await fetch(document.querySelector('#large-preview').src)).blob(); const a = new Uint8Array(await b.arrayBuffer()); let s = ''; for (const x of a) s += String.fromCharCode(x); return btoa(s); })()`);
    fs.writeFileSync(stillShot, Buffer.from(largeB64, 'base64'));
    console.log('large image:', stillShot);

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
