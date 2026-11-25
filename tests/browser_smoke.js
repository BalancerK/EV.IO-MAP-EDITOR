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

    // ---- item 5: multi-select, group turn, copy/paste, mirror, hide, box select, lock, arrow keys
    const clickMod = async (x, y, modifiers) => {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers });
        await sleep(150);
    };
    const keyPress = async (k, code, vk, modifiers = 0, holdMs = 0) => {
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
        if (holdMs) await sleep(holdMs);
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
        await sleep(150);
    };
    const inspectorTitle = () => evaluate(`document.querySelector('#inspector h3')?.textContent || ''`);
    const selCount = () => evaluate(`window.__mapEditor.state.selected.length`);
    const buttonByText = (t) => evaluate(`[...document.querySelectorAll('#inspector button')].find((b) => b.textContent === ${JSON.stringify(t)}).click()`);

    await press('[data-key="b:Box"]');
    await click(vp.x, vp.y + 150);
    await press('[data-tool="select"]');
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await click(vp.x, vp.y - 10);
    await clickMod(vp.x, vp.y + 150, 8);              // Shift+click
    check(/^2 selected/.test(await inspectorTitle()), `Shift+click adds to the selection ("${await inspectorTitle()}")`);
    d = await doc();
    const two = (await evaluate(`window.__mapEditor.state.selected.map((s) => s.id)`));
    const posOf = (dd, id) => dd.blocks.find((b) => b.id === id).position;
    const gap = (dd) => Math.hypot(posOf(dd, two[0]).x - posOf(dd, two[1]).x, posOf(dd, two[0]).z - posOf(dd, two[1]).z);
    const gapBefore = gap(d), p0 = posOf(d, two[0]);
    await keyPress(']', 'BracketRight', 221);
    d = await doc();
    check(Math.abs(gap(d) - gapBefore) < 1e-6 && (posOf(d, two[0]).x !== p0.x || posOf(d, two[0]).z !== p0.z), '] turns the group around its centre (spacing kept)');
    check(d.blocks.find((b) => b.id === two[0]).rotation.y !== 0, '] also turns each block');

    // Group gizmo: move the pivot as a drag would, then commit as the drag's end does.
    const moved = await evaluate(`(() => {
        const v = window.__mapEditor.viewport;
        if (v.gizmo.object !== v.pivot) return 'gizmo not on the group pivot';
        v.pivot.position.x += 4; v.pivot.position.z -= 2; v.applyGroupDrag(); v.commitGizmo();
        return 'ok';
    })()`);
    const dm = await doc();
    check(moved === 'ok' && two.every((id) => Math.abs(posOf(dm, id).x - posOf(d, id).x - 4) < 1e-6 && Math.abs(posOf(dm, id).z - posOf(d, id).z + 2) < 1e-6), `dragging the group gizmo moves every selected block (${moved})`);
    d = dm;

    let nBlocks = d.blocks.length;
    await buttonByText('Copy');
    await buttonByText('Paste');
    d = await doc();
    check(d.blocks.length === nBlocks + 2 && (await selCount()) === 2, `Copy + Paste adds 2 blocks and selects them (${d.blocks.length - nBlocks})`);
    nBlocks = d.blocks.length;
    const pasted = await evaluate(`window.__mapEditor.state.selected.map((s) => s.id)`);
    const before = pasted.map((id) => posOf(d, id));
    await buttonByText('Mirror copy ⇆');
    d = await doc();
    const mirrored = await evaluate(`window.__mapEditor.state.selected.map((s) => s.id)`);
    check(d.blocks.length === nBlocks + 2, 'Mirror copy adds the mirrored pieces');
    check(mirrored.every((id) => before.some((p) => Math.abs(posOf(d, id).z - p.z) < 1e-6)), 'mirrored copies keep their front-back position');

    await keyPress('h', 'KeyH', 72);
    d = await doc();
    check(mirrored.every((id) => d.blocks.find((b) => b.id === id).hidden) && (await selCount()) === 0, 'H hides the selection');
    check((await evaluate(`document.querySelectorAll('#outliner li.is-hidden').length`)) === 2, 'hidden pieces are struck through in the scene list');
    await keyPress('H', 'KeyH', 72, 8);
    d = await doc();
    check(!d.blocks.some((b) => b.hidden), 'Shift+H shows everything again');

    // Box select: drag across the middle of the view.
    const dragBox = async (x0, y0, x1, y1) => {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 });
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 });
        for (let i = 1; i <= 6; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x1 - x0) * i / 6, y: y0 + (y1 - y0) * i / 6, button: 'left', buttons: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 });
        await sleep(200);
    };
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await dragBox(vp.x - 260, vp.y - 220, vp.x + 260, vp.y + 230);
    const boxed = await selCount();
    check(boxed >= 6, `dragging a box selects what is inside it (${boxed} items)`);
    await buttonByText('Lock');
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await dragBox(vp.x - 260, vp.y - 220, vp.x + 260, vp.y + 230);
    check((await selCount()) === 0, 'locked pieces are skipped by box select');
    await click(vp.x, vp.y - 10);
    check((await selCount()) === 0, 'locked pieces cannot be clicked in the view');
    // Unlock everything again for the rest of the test.
    const unlocked = await evaluate(`(() => { let n = 0; for (;;) { const b = document.querySelector('#outliner .icon-btn.on[title^="Locked"]'); if (!b || n > 100) return n; b.click(); n++; } })()`);
    check(unlocked === boxed, `the scene list's lock toggles unlock them again (${unlocked})`);

    const camBefore = await evaluate(`window.__mapEditor.viewport.camera.position.toArray()`);
    await keyPress('ArrowUp', 'ArrowUp', 38, 0, 500);
    const camAfter = await evaluate(`window.__mapEditor.viewport.camera.position.toArray()`);
    check(Math.hypot(camAfter[0] - camBefore[0], camAfter[2] - camBefore[2]) > 1 && Math.abs(camAfter[1] - camBefore[1]) < 1e-6, `ArrowUp slides the view forward along the ground (${camBefore.map((v) => v.toFixed(1))} -> ${camAfter.map((v) => v.toFixed(1))})`);

    // ---- item 4: Auto nav
    await press('[data-key="o:Auto nav"]');
    await sleep(200);
    check(await evaluate(`document.querySelector('#nav-dialog').open`), 'Auto nav opens the generator dialog');
    await press('#nav-generate');
    await sleep(500);
    d = await doc();
    const navText = await evaluate(`document.querySelector('#nav-result').innerText`);
    check(d.navNodes.length > 50 && d.navNodes.some((n) => n.links.length), `Generate fills the map with linked nav nodes (${d.navNodes.length}): ${navText.split(String.fromCharCode(10))[0]}`);
    check(!d.navNodes.some((n) => d.blocks.some((b) => b.shape === 'box' && b.collision !== 'visual' && Math.abs(n.position.x - b.position.x) < b.size.x / 2 - 0.05 && Math.abs(n.position.z - b.position.z) < b.size.z / 2 - 0.05 && n.position.y > b.position.y - b.size.y / 2 + 0.2 && n.position.y < b.position.y + b.size.y / 2 - 0.05)), 'no generated node is inside a box');
    await evaluate(`document.querySelector('#nav-dialog').close()`);
    check((await evaluate(`document.querySelector('#btn-images').textContent`)) === 'Export images', 'the images button reads "Export images"');

    // ---- item 3: walk test (headless has no pointer lock: the view falls back to drag-to-look)
    {
        await evaluate(`window.__mapEditor.viewport.camera.position.set(30, 25, 30)`);
        await sleep(200);
        const editorCam = await evaluate(`window.__mapEditor.viewport.camera.position.toArray()`);
        const gizmoBefore = await evaluate(`document.querySelector('[data-gizmo].active').dataset.gizmo`);
        await press('#btn-walk');
        await sleep(1500);   // drop onto the floor
        check(!(await evaluate(`document.querySelector('#walk-hud').hidden`)), 'Walk test shows its HUD');
        const p0 = await evaluate(`(() => { const w = window.__mapEditor.viewport.walk; return { ...w.player.pos, grounded: w.player.grounded, cam: window.__mapEditor.viewport.camera.position.y }; })()`);
        check(p0.grounded && Math.abs(p0.cam - p0.y - 1.8) < 0.05, `starts standing at a spawn with the game's eye height (feet ${p0.y.toFixed(2)}, eye +${(p0.cam - p0.y).toFixed(2)})`);
        await keyPress('w', 'KeyW', 87, 0, 700);
        const p1 = await evaluate(`({ ...window.__mapEditor.viewport.walk.player.pos })`);
        const walked = Math.hypot(p1.x - p0.x, p1.z - p0.z);
        check(walked > 3, `holding W walks (${walked.toFixed(1)} m in 0.7 s)`);
        check((await evaluate(`document.querySelector('[data-gizmo].active').dataset.gizmo`)) === gizmoBefore, 'walking keys do not reach the editor shortcuts');
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
        await sleep(300);
        const p2 = await evaluate(`({ ...window.__mapEditor.viewport.walk.player.pos })`);
        check(p2.y > p1.y + 1.5, `Space jumps (feet ${p1.y.toFixed(2)} -> ${p2.y.toFixed(2)} after 0.3 s)`);
        const yaw0 = await evaluate(`window.__mapEditor.viewport.walk.yaw`);
        const mid = await evaluate(`(() => { const r = document.querySelector('#viewport').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        const selBefore = await selCount();
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mid.x, y: mid.y, button: 'left', clickCount: 1 });
        for (let i = 1; i <= 5; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mid.x + i * 30, y: mid.y, button: 'left', buttons: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mid.x + 150, y: mid.y, button: 'left', clickCount: 1 });
        await sleep(200);
        const yaw1 = await evaluate(`window.__mapEditor.viewport.walk.yaw`);
        check(Math.abs(yaw1 - yaw0) > 5, `dragging turns the view (yaw ${yaw0.toFixed(0)} -> ${yaw1.toFixed(0)})`);
        check((await selCount()) === selBefore, 'clicking in the walk test does not select or deselect');
        await sleep(800);
        const img = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(shot.replace(/\.png$/, '-walk.png'), Buffer.from(img.result.data, 'base64'));
        await keyPress('Escape', 'Escape', 27);
        check(await evaluate(`document.querySelector('#walk-hud').hidden && !window.__mapEditor.viewport.walk`), 'Esc leaves the walk test');
        const back = await evaluate(`window.__mapEditor.viewport.camera.position.toArray()`);
        check(Math.hypot(back[0] - editorCam[0], back[1] - editorCam[1], back[2] - editorCam[2]) < 1e-3, 'leaving restores the editor view');
    }

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
    const docNow = await doc();
    check(m.teleporters.length === docNow.teleporters.length && m.aiNavNodes.length === docNow.navNodes.length, `teleporters and nav nodes exported (${m.aiNavNodes.length} nav nodes)`);
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

    // Export images: exact sizes and formats, real content (not a blank frame), view switching.
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

    // ---- item 6: open an official map (.evmap) through the real file picker
    const officialMap = process.env.EVIO_TEST_MAP || path.join(serverDir, 'map_cache', 'HUT8Bishop.evmap');
    if (!fs.existsSync(officialMap)) console.log(`(no ${officialMap}: skipping the open-.evmap checks)`);
    else {
        await evaluate(`document.querySelectorAll('dialog[open]').forEach((d) => d.close())`);
        const { root } = (await send('DOM.getDocument')).result;
        const { nodeId } = (await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file-input' })).result;
        await send('DOM.setFileInputFiles', { nodeId, files: [path.resolve(officialMap)] });
        let pieces = 0;
        for (let i = 0; i < 60 && !pieces; i++) { await sleep(250); pieces = await evaluate(`window.__mapEditor.viewport.modelObjects.size`); }
        const od = await evaluate(`(() => { const d = window.__mapEditor.state.doc; return { models: d.models.length, spawns: d.playerSpawns.length, nav: d.navNodes.length, blocks: d.blocks.length, base: d.base && d.base.file, name: d.name }; })()`);
        check(od.models > 50 && pieces === od.models && od.base === path.basename(officialMap), `Open .evmap shows the map's pieces (${pieces} of ${od.models}, "${od.name}")`);
        check(od.spawns > 10 && od.nav > 50 && od.blocks === 0, `its spawns and nav nodes become editable (${od.spawns} spawns, ${od.nav} nav nodes)`);
        await sleep(1500);   // textures
        const imgO = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(shot.replace(/\.png$/, '-opened.png'), Buffer.from(imgO.result.data, 'base64'));
        // Click the middle of the view: it should pick a piece of the map.
        await evaluate(`window.__mapEditor.viewport.frameBox && 0`);
        const vpRect = await evaluate(`(() => { const r = document.querySelector('#viewport').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        await click(vpRect.x, vpRect.y);
        const picked = await evaluate(`window.__mapEditor.state.selection`);
        check(picked && picked.kind === 'models', `clicking the map selects one of its pieces (${picked && picked.kind})`);
        // Move it up 3 m through the inspector, and check the export.
        if (picked && picked.kind === 'models') {
            const before = await evaluate(`window.__mapEditor.state.doc.models.find((m) => m.id === ${JSON.stringify(picked.id)}).position`);
            await evaluate(`(() => { const i = document.querySelector('#inspector [aria-label="Position y"]'); i.value = String(${before.y} + 3); i.dispatchEvent(new Event('change')); })()`);
            await sleep(200);
            const objY = await evaluate(`window.__mapEditor.viewport.modelObjects.get(${JSON.stringify(picked.id)}).position.y`);
            check(Math.abs(objY - before.y - 3) < 1e-3, 'editing the position moves the piece in the view');
        }
        const out = await evaluate(`(async () => {
            const { compileDocument } = await import('/src/model/compile.js');
            const { writeEvmap } = await import('/src/evmap/format.js');
            const bytes = writeEvmap(compileDocument(window.__mapEditor.state.doc));
            let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)); return btoa(s);
        })()`);
        const ob = Buffer.from(out, 'base64');
        const orig = fs.readFileSync(officialMap);
        const require2 = createRequire(import.meta.url);
        const bpw2 = require2(`${serverDir}/physics_world.js`);
        const ga = bpw2.parseEvmapBuffer(orig, 'orig'), gb = bpw2.parseEvmapBuffer(ob, 'export');
        check(ga.indices.length === gb.indices.length && ga.spawns.length === gb.spawns.length, `the edited map exports with all its collision (${gb.indices.length / 3} triangles) and spawns`);
        // Walk test on the opened map.
        await press('#btn-walk');
        await sleep(2500);
        const wp = await evaluate(`(() => { const w = window.__mapEditor.viewport.walk; return w ? { grounded: w.player.grounded, y: w.player.pos.y } : null; })()`);
        check(wp && wp.grounded && wp.y > -29, `the walk test stands on the opened map (feet at ${wp && wp.y.toFixed(2)})`);
        await keyPress('Escape', 'Escape', 27);
        // Reload: the map file comes back from the browser's storage.
        await send('Page.reload');
        let back = 0;
        for (let i = 0; i < 60 && !back; i++) { await sleep(250); back = await evaluate(`window.__mapEditor ? window.__mapEditor.viewport.modelObjects.size : 0`); }
        check(back === pieces, `after a reload the pieces come back without opening the file again (${back})`);
    }
    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
    console.log('screenshot:', shot);
    ws.close();
}

main().catch((e) => { console.error(e); failures++; }).finally(() => {
    proc.kill();
    console.log(failures ? `${failures} FAILED` : 'browser smoke test passed');
    process.exit(failures ? 1 : 0);
});
