// EV.IO Map Editor — application state, panels and file handling. The document (src/model/document.js)
// is the single source of truth; every edit goes through change(), which records undo history,
// re-renders and autosaves.
import { Viewport } from './editor/viewport.js';
import { newDocument, normaliseDocument, newId, validate, COLLISION, TEAMS } from './model/document.js';
import { compileDocument, generateCameraPaths } from './model/compile.js';
import { generateNavNodes, navReport } from './model/navgen.js';
import { buildBlockTriangles, blocksBounds } from './model/geometry.js';
import { collect, remapIds, translate, rotateY, mirror, insert, replace, removeSelection, centreOf, toClipboardText, fromClipboardText } from './model/edit.js';
import { writeEvmap } from './evmap/format.js';

const STORAGE_KEY = 'evio-map-editor:doc';
const OLD_STORAGE_KEY = 'evmap-forge:doc';   // the editor's earlier name; migrated on load
const $ = (sel) => document.querySelector(sel);

// ------------------------------------------------------------------ pieces
const BLOCK_PIECES = [
    { label: 'Box', shape: 'box', size: { x: 4, y: 4, z: 4 } },
    { label: 'Floor', shape: 'box', size: { x: 8, y: 0.5, z: 8 } },
    { label: 'Wall', shape: 'box', size: { x: 8, y: 4, z: 0.5 } },
    { label: 'Ramp', shape: 'ramp', size: { x: 4, y: 2, z: 6 } },
    { label: 'Stairs', shape: 'stairs', size: { x: 3, y: 3, z: 6 } },
    { label: 'Corner', shape: 'wedge-corner', size: { x: 4, y: 2, z: 4 } },
    { label: 'Pillar', shape: 'cylinder', size: { x: 2, y: 4, z: 2 } },
    { label: 'Platform', shape: 'box', size: { x: 6, y: 0.5, z: 6 } },
];
const OBJECT_PIECES = [
    { label: 'Spawn', type: 'playerSpawns', team: 'neutral', color: 'var(--spawn)' },
    { label: 'Team 1', type: 'playerSpawns', team: 'team1', color: '#4f8fff' },
    { label: 'Team 2', type: 'playerSpawns', team: 'team2', color: '#ff8a3d' },
    { label: 'Weapon', type: 'weaponSpawns', color: 'var(--weapon)' },
    { label: 'Teleporter', type: 'teleporters', color: 'var(--teleport)' },
    { label: 'Nav node', type: 'navNodes', color: 'var(--nav)' },
    { label: 'Auto nav', type: 'navAuto', color: 'var(--nav)', instant: true, title: 'Generate bot nav nodes over every walkable floor' },
    { label: 'Camera', type: 'cameraPaths', color: 'var(--camera)', instant: true },
    { label: 'Auto paths', type: 'cameraAuto', color: 'var(--camera)', instant: true, title: 'Generate 6 menu camera paths circling the map' },
    { label: 'BR circle', type: 'brCircle', color: 'var(--teleport)', instant: true },
];
const svg = (d) => `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
    eye: svg('<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>'),
    eyeOff: svg('<path d="M2 2l12 12M6.6 4.1A6.6 6.6 0 0 1 8 3.5c4.1 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.9 2.4M9.9 11.9A6 6 0 0 1 8 12.5C3.9 12.5 1.5 8 1.5 8a11 11 0 0 1 2.3-2.8"/>'),
    lock: svg('<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>'),
    unlock: svg('<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7"/>'),
};
const KIND_LABEL = { block: 'Block', playerSpawns: 'Player spawn', weaponSpawns: 'Weapon spawn', teleporters: 'Teleporter', navNodes: 'Nav node', cameraPaths: 'Camera path', brCircle: 'Battle royale circle' };
const KIND_COLOR = { playerSpawns: 'var(--spawn)', weaponSpawns: 'var(--weapon)', teleporters: 'var(--teleport)', navNodes: 'var(--nav)', cameraPaths: 'var(--camera)', brCircle: 'var(--teleport)' };
const SHAPE_LABEL = { box: 'Box', ramp: 'Ramp', stairs: 'Stairs', cylinder: 'Cylinder', 'wedge-corner': 'Corner wedge' };

// ------------------------------------------------------------------ state
const state = {
    doc: loadAutosave() || newDocument(),
    selection: null,     // the primary (last clicked) item: drives the gizmo and single-item panel
    selected: [],        // everything selected (multi-select), including the primary
    tool: 'select',
    piece: null,
    currentMaterial: 'mat_concrete',
    undo: [],
    redo: [],
    tab: 'inspector',
};

function loadAutosave() {
    try {
        let raw = localStorage.getItem(STORAGE_KEY);
        if (!raw && (raw = localStorage.getItem(OLD_STORAGE_KEY))) {
            localStorage.setItem(STORAGE_KEY, raw);
            localStorage.removeItem(OLD_STORAGE_KEY);
        }
        return raw ? normaliseDocument(JSON.parse(raw)) : null;
    } catch { return null; }
}
function autosave() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.doc)); } catch { /* private mode or quota: ignore */ }
}

function change(fn, { keepRedo = false } = {}) {
    state.undo.push(JSON.stringify(state.doc));
    if (state.undo.length > 150) state.undo.shift();
    if (!keepRedo) state.redo = [];
    fn(state.doc);
    refresh();
}
function undo() {
    if (!state.undo.length) return;
    state.redo.push(JSON.stringify(state.doc));
    state.doc = JSON.parse(state.undo.pop());
    if (state.selection && !findSelected()) state.selection = null;
    refresh();
}
function redo() {
    if (!state.redo.length) return;
    state.undo.push(JSON.stringify(state.doc));
    state.doc = JSON.parse(state.redo.pop());
    if (state.selection && !findSelected()) state.selection = null;
    refresh();
}

function listFor(kind) { return kind === 'block' ? state.doc.blocks : state.doc[kind]; }
function findSelected() {
    const s = state.selection;
    if (!s) return null;
    if (s.kind === 'brCircle') return state.doc.brCircle;
    return (listFor(s.kind) || []).find((x) => x.id === s.id) || null;
}

// ------------------------------------------------------------------ viewport
const viewport = new Viewport($('#viewport'), {
    onSelect(sel, opts) { select(sel, opts); },
    onMarquee(found, { additive }) { selectMany(additive ? mergeSel(state.selected, found) : found); },
    onGroupTransform(list, t) {
        change((doc) => {
            const groups = collect(doc, list);
            if (t.turn) rotateY(groups, t.turn, t.pivot);
            translate(groups, t.delta);
            replace(doc, groups);
        });
    },
    onPlace(pos) { placePiece(pos); },
    onTransform(sel, t) {
        change((doc) => {
            if (sel.kind === 'block') {
                const b = doc.blocks.find((x) => x.id === sel.id);
                if (b) Object.assign(b, { position: t.position, rotation: t.rotation, size: t.size });
            } else if (sel.kind === 'brCircle') {
                doc.brCircle.position = t.delta;
            } else if (sel.kind === 'cameraPaths') {
                const c = doc.cameraPaths.find((x) => x.id === sel.id);
                if (c && t.part) c[t.part].position = t.delta;
            } else {
                const item = (doc[sel.kind] || []).find((x) => x.id === sel.id);
                if (item) item.position = t.delta;
            }
        });
    },
    onHover(p) { $('#hud-coords').textContent = `x ${p.x.toFixed(1)}  y ${p.y.toFixed(1)}  z ${p.z.toFixed(1)}`; },
    onFlyoverEnd() { toast('Camera preview finished'); },
    onFlyover(i, n) { if (n > 1) toast(`Menu loop: camera path ${i + 1} of ${n} · Esc to stop`); },
    onFramingChange(f) { renderFramingBanner(f); },
    onWalkChange(info) { renderWalkHud(info); },
    onWalkEvent(kind) {
        if (kind === 'fell') toast('Fell into the kill zone: back to the spawn');
        else if (kind === 'respawned') toast('Next spawn');
    },
});

const sameSel = (a, b) => a.kind === b.kind && a.id === b.id;
const mergeSel = (a, b) => [...a, ...b.filter((x) => !a.some((y) => sameSel(x, y)))];

// Select one item; with additive (Shift/Ctrl/Cmd-click) add it to, or remove it from, the selection.
function select(sel, { additive = false } = {}) {
    if (additive && sel) {
        const i = state.selected.findIndex((s) => sameSel(s, sel));
        const next = state.selected.slice();
        if (i >= 0) next.splice(i, 1); else next.push({ kind: sel.kind, id: sel.id });
        return selectMany(next);
    }
    state.selected = sel ? [sel] : [];
    state.selection = sel;
    viewport.selectMany(state.selected, sel);
    if (sel) setTab('inspector');
    renderOutliner();
    renderInspector();
}
function selectMany(list) {
    if (list.length <= 1) return select(list[0] || null);
    state.selected = list.slice();
    state.selection = list[list.length - 1];
    viewport.selectMany(state.selected, state.selection);
    setTab('inspector');
    renderOutliner();
    renderInspector();
}
function existsSel(s) {
    if (s.kind === 'brCircle') return !!state.doc.brCircle;
    return !!(listFor(s.kind) || []).find((x) => x.id === s.id);
}
function selectAll() {
    const all = [];
    const add = (kind, items) => items.forEach((it) => { if (!it.hidden && !it.locked) all.push({ kind, id: it.id }); });
    add('block', state.doc.blocks);
    for (const k of ['playerSpawns', 'weaponSpawns', 'teleporters', 'navNodes']) add(k, state.doc[k]);
    selectMany(all);
}

// ------------------------------------------------------------------ arrange: copy, rotate, mirror
const CLIP_KEY = 'evio-map-editor:clipboard';
const selectedEditable = () => state.selected.filter((s) => s.kind !== 'brCircle');
function copySelection() {
    const groups = collect(state.doc, selectedEditable());
    const n = Object.values(groups).reduce((s, l) => s + l.length, 0);
    if (!n) return null;
    const text = toClipboardText(groups);
    try { localStorage.setItem(CLIP_KEY, text); } catch { /* storage off: system clipboard only */ }
    toast(`Copied ${n} item${n === 1 ? '' : 's'}`);
    return text;
}
function pasteText(text) {
    let groups = fromClipboardText(text || '');
    if (!groups) { try { groups = fromClipboardText(localStorage.getItem(CLIP_KEY) || ''); } catch { groups = null; } }
    if (!groups) { toast('Nothing to paste: copy something in the editor first'); return; }
    const pasted = remapIds(groups);
    translate(pasted, { x: viewport.grid * 2, y: 0, z: viewport.grid * 2 });
    let sel;
    change((doc) => { sel = insert(doc, pasted); });
    selectMany(sel);
    toast(`Pasted ${sel.length} item${sel.length === 1 ? '' : 's'}`);
}
async function pasteFromButton() {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { /* no permission: use the editor's own copy */ }
    pasteText(text);
}
function copyFromButton() {
    const text = copySelection();
    if (text) navigator.clipboard?.writeText(text).catch(() => {});
}
function duplicateSelected() {
    const groups = collect(state.doc, selectedEditable());
    if (!Object.keys(groups).length) return;
    const copies = remapIds(groups);
    translate(copies, { x: viewport.grid * 2, y: 0, z: viewport.grid * 2 });
    let sel;
    change((doc) => { sel = insert(doc, copies); });
    selectMany(sel);
}
function deleteSelected() {
    if (!state.selected.length) return;
    const list = state.selected.slice();
    change((doc) => removeSelection(doc, list));
    select(null);
}
function rotateSelection(degrees) {
    const list = selectedEditable();
    if (!list.length) return;
    change((doc) => {
        const groups = collect(doc, list);
        rotateY(groups, degrees, centreOf(groups));
        replace(doc, groups);
    });
}
// Mirror copy: across the map's centre line (left↔right = x, front↔back = z), swapping team 1 and
// team 2 spawns, for symmetrical maps. Flip: in place, about the selection's own centre.
function mapCentre() {
    if (!state.doc.blocks.length) return { x: 0, y: 0, z: 0 };
    const { min, max } = blocksBounds(state.doc.blocks);
    return { x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2, z: (min[2] + max[2]) / 2 };
}
function mirrorCopy(axis) {
    const groups = collect(state.doc, selectedEditable());
    if (!Object.keys(groups).length) return;
    const copies = mirror(remapIds(groups), axis, mapCentre()[axis], { swapTeams: true });
    let sel;
    change((doc) => { sel = insert(doc, copies); });
    selectMany(sel);
    toast(`Mirrored copy across the map's ${axis === 'x' ? 'left-right' : 'front-back'} centre line (teams swapped)`);
}
function flipSelection(axis) {
    const list = selectedEditable();
    if (!list.length) return;
    change((doc) => {
        const groups = collect(doc, list);
        mirror(groups, axis, centreOf(groups)[axis]);
        replace(doc, groups);
    });
}
function setFlag(flag, value, list = selectedEditable()) {
    if (!list.length) return;
    change((doc) => {
        for (const s of list) {
            const item = (s.kind === 'block' ? doc.blocks : doc[s.kind] || []).find((x) => x.id === s.id);
            if (item) { if (value) item[flag] = true; else delete item[flag]; }
        }
    });
    if (value) select(null);
}
function showAll() {
    change((doc) => { for (const k of ['blocks', 'playerSpawns', 'weaponSpawns', 'teleporters', 'navNodes', 'cameraPaths']) for (const it of doc[k]) delete it.hidden; });
    toast('Everything is visible again');
}
function arrangeCard() {
    return el('div', { class: 'card' },
        el('strong', {}, 'Arrange'),
        el('div', { class: 'row' },
            el('button', { type: 'button', title: 'Turn 90° to the left ( [ )', onclick: () => rotateSelection(90) }, 'Turn ⟲ 90°'),
            el('button', { type: 'button', title: 'Turn 90° to the right ( ] )', onclick: () => rotateSelection(-90) }, 'Turn ⟳ 90°')),
        el('div', { class: 'row' },
            el('button', { type: 'button', title: "Mirrored copy on the other side of the map's centre line; team 1 and team 2 spawns swap", onclick: () => mirrorCopy('x') }, 'Mirror copy ⇆'),
            el('button', { type: 'button', title: "Mirrored copy across the map's front-back centre line; teams swap", onclick: () => mirrorCopy('z') }, 'Mirror copy ⇅')),
        el('div', { class: 'row' },
            el('button', { type: 'button', title: 'Flip left-right in place', onclick: () => flipSelection('x') }, 'Flip ⇆'),
            el('button', { type: 'button', title: 'Flip front-back in place', onclick: () => flipSelection('z') }, 'Flip ⇅')),
        el('div', { class: 'row' },
            el('button', { type: 'button', title: 'Copy (Ctrl+C)', onclick: copyFromButton }, 'Copy'),
            el('button', { type: 'button', title: 'Paste (Ctrl+V)', onclick: pasteFromButton }, 'Paste'),
            el('button', { type: 'button', title: 'Hide in the editor (H). Hidden pieces are still exported.', onclick: () => setFlag('hidden', true) }, 'Hide'),
            el('button', { type: 'button', title: 'Lock: cannot be clicked or box-selected in the view', onclick: () => setFlag('locked', true) }, 'Lock')));
}
function renderMultiInspector(rootEl) {
    const items = state.selected.map((s) => ({ s, item: s.kind === 'brCircle' ? state.doc.brCircle : (listFor(s.kind) || []).find((x) => x.id === s.id) })).filter((x) => x.item);
    const counts = {};
    for (const { s } of items) counts[s.kind] = (counts[s.kind] || 0) + 1;
    rootEl.append(el('h3', {}, `${items.length} selected`));
    rootEl.append(el('p', { class: 'empty' }, Object.entries(counts).map(([k, n]) => `${n} ${(KIND_LABEL[k] || k).toLowerCase()}${n === 1 ? '' : 's'}`).join(' · ')
        + '. Drag the gizmo to move them together; in Rotate mode they turn around their centre.'));
    const blocks = items.filter((x) => x.s.kind === 'block');
    if (blocks.length) {
        const setAll = (fn) => change((doc) => { for (const { s } of blocks) { const b = doc.blocks.find((x) => x.id === s.id); if (b) fn(b); } });
        const first = blocks[0].item;
        rootEl.append(selectField('Material (all selected blocks)', blocks.every((b) => b.item.materialId === first.materialId) ? first.materialId : '',
            [['', 'Mixed'], ...state.doc.materials.map((m) => [m.id, m.name])], (v) => { if (v) setAll((b) => { b.materialId = v; }); }));
        rootEl.append(selectField('Collision (all selected blocks)', blocks.every((b) => (b.item.collision || 'solid') === (first.collision || 'solid')) ? (first.collision || 'solid') : '', [
            ['', 'Mixed'], [COLLISION.SOLID, 'Solid (visible, collides)'], [COLLISION.VISUAL, 'Decoration (no collision)'], [COLLISION.INVISIBLE, 'Invisible wall'],
        ], (v) => { if (v) setAll((b) => { b.collision = v; }); }));
    }
    rootEl.append(arrangeCard());
    rootEl.append(el('div', { class: 'row' },
        el('button', { type: 'button', onclick: duplicateSelected }, 'Duplicate'),
        el('button', { type: 'button', class: 'danger', onclick: deleteSelected }, `Delete ${items.length}`)));
}

function placePiece(pos) {
    const p = state.piece;
    if (!p) return;
    let created = null;
    change((doc) => {
        if (p.kind === 'block') {
            const block = { id: newId('blk'), shape: p.shape, position: pos, rotation: { x: 0, y: 0, z: 0 }, size: { ...p.size }, materialId: state.currentMaterial, collision: COLLISION.SOLID, shadows: true };
            if (p.shape === 'stairs') block.steps = 6;
            if (p.shape === 'cylinder') block.segments = 16;
            doc.blocks.push(block);
            created = { kind: 'block', id: block.id };
        } else if (p.type === 'playerSpawns') {
            const s = { id: newId('spawn'), position: pos, yaw: 0, team: p.team };
            doc.playerSpawns.push(s);
            created = { kind: 'playerSpawns', id: s.id };
        } else if (p.type === 'weaponSpawns') {
            const w = { id: newId('wpn'), position: pos };
            doc.weaponSpawns.push(w);
            created = { kind: 'weaponSpawns', id: w.id };
        } else if (p.type === 'teleporters') {
            const t = { id: newId('tp'), position: pos, yaw: 0, radius: 1.5, destinations: [] };
            // Placing right after selecting an unpaired teleporter pairs the two, both ways.
            const prev = state.selection?.kind === 'teleporters' ? doc.teleporters.find((x) => x.id === state.selection.id) : null;
            if (prev && !prev.destinations.length) { prev.destinations.push(t.id); t.destinations.push(prev.id); }
            doc.teleporters.push(t);
            created = { kind: 'teleporters', id: t.id };
        } else if (p.type === 'navNodes') {
            const n = { id: newId('nav'), position: pos, links: [] };
            const prev = state.selection?.kind === 'navNodes' ? doc.navNodes.find((x) => x.id === state.selection.id) : null;
            if (prev && $('#chain-nav').checked) prev.links.push(n.id);
            doc.navNodes.push(n);
            created = { kind: 'navNodes', id: n.id };
        }
    });
    // Stay in place mode, but select what was just placed so chaining (nav, teleporters) works.
    state.selection = created;
    state.selected = created ? [created] : [];
    viewport.selectMany(state.selected, created);
    renderOutliner();
    renderInspector();
}

// ------------------------------------------------------------------ camera paths
// New path, in two framed shots: fly to the start shot and press Enter, then to the end shot.
function addCameraPath() {
    setTool('select');
    viewport.startFraming(null, {
        label: 'New camera path · 1 of 2 · frame the START shot',
        onSave: (start) => viewport.startFraming(start, {
            label: 'New camera path · 2 of 2 · frame the END shot',
            onSave: (end) => {
                let id;
                change((doc) => { id = newId('cam'); doc.cameraPaths.push({ id, start, end, seconds: 25 }); });
                select({ kind: 'cameraPaths', id });
                toast('Camera path added');
            },
            onCancel: () => toast('New camera path cancelled'),
        }),
        onCancel: () => toast('New camera path cancelled'),
    });
}

function frameShot(id, key) {
    const c = state.doc.cameraPaths.find((x) => x.id === id);
    if (!c) return;
    const i = state.doc.cameraPaths.indexOf(c);
    viewport.startFraming(c[key], {
        label: `Camera path ${i + 1} · frame the ${key.toUpperCase()} shot`,
        onSave: (pose) => {
            change((doc) => { const t = doc.cameraPaths.find((x) => x.id === id); if (t) t[key] = pose; });
            toast(`${key === 'start' ? 'Start' : 'End'} shot saved`);
        },
    });
}

function generatePaths() {
    if (state.doc.cameraPaths.length && !confirm(`Replace your ${state.doc.cameraPaths.length} camera path(s) with 6 new ones circling the map?`)) return;
    let paths;
    change((doc) => { paths = generateCameraPaths(doc, newId); doc.cameraPaths = paths; });
    select({ kind: 'cameraPaths', id: paths[0].id });
    toast('6 camera paths circle the map · press Play menu loop to watch');
}

function playMenuLoop() {
    if (!state.doc.cameraPaths.length) { toast('No camera paths yet'); return; }
    viewport.playFlyover(state.doc.cameraPaths);
}

// ------------------------------------------------------------------ walk test
// Start at the selected player spawn, else the spawn nearest the middle of the view, else drop in
// from the camera. R cycles through the spawns; falling into the kill zone returns to the last one.
function startWalkTest() {
    const doc = state.doc;
    if (!doc.blocks.some((b) => b.collision !== 'visual')) { toast('Nothing to walk on yet: add a solid block first'); return; }
    const spawns = doc.playerSpawns.map((s) => ({ position: { ...s.position }, yaw: s.yaw || 0 }));
    let idx = state.selection?.kind === 'playerSpawns' ? doc.playerSpawns.findIndex((s) => s.id === state.selection.id) : -1;
    if (idx < 0 && spawns.length) {
        const t = viewport.orbit.target;
        let best = Infinity;
        spawns.forEach((s, i) => { const d = (s.position.x - t.x) ** 2 + (s.position.y - t.y) ** 2 + (s.position.z - t.z) ** 2; if (d < best) { best = d; idx = i; } });
    }
    const start = idx >= 0 ? { ...spawns[idx], spawnIndex: idx } : { position: viewport.viewPose().position, yaw: viewport.viewPose().yaw };
    viewport.startWalk(doc, start, { spawns });
}
function renderWalkHud(info) {
    const hud = $('#walk-hud');
    document.querySelector('.viewport-wrap').classList.toggle('walking', !!info);
    if (!info) { hud.hidden = true; return; }
    hud.hidden = false;
    $('#walk-spawn').textContent = info.spawn ? `spawn ${info.spawn}` : '';
    const speed = $('#walk-speed');
    speed.textContent = `${info.speed.toFixed(1)} m/s`;
    speed.classList.toggle('sprint', info.sprinting);
    $('#walk-jumps').textContent = String(info.jumpsLeft);
    $('#walk-height').textContent = `${info.height.toFixed(1)} m`;
    $('#walk-paused').hidden = !info.paused;
}

function renderFramingBanner(f) {
    const b = $('#frame-banner');
    if (!f) { b.hidden = true; return; }
    b.hidden = false;
    $('#frame-label').textContent = f.label || 'Framing a camera shot';
    $('#frame-speed').textContent = `${Math.round(f.speed)} m/s`;
}

function addInstantPiece(p) {
    if (p.type === 'cameraPaths') {
        addCameraPath();
    } else if (p.type === 'cameraAuto') {
        generatePaths();
    } else if (p.type === 'navAuto') {
        openNavDialog();
    } else if (p.type === 'brCircle') {
        if (state.doc.brCircle) { select({ kind: 'brCircle', id: 'brCircle' }); return; }
        const xs = state.doc.blocks.map((b) => b.position);
        const cx = xs.reduce((s, q) => s + q.x, 0) / (xs.length || 1), cz = xs.reduce((s, q) => s + q.z, 0) / (xs.length || 1);
        change((doc) => { doc.brCircle = { position: { x: round(cx), y: 0, z: round(cz) }, radius: 60 }; });
        select({ kind: 'brCircle', id: 'brCircle' });
    }
}

function setTool(tool, piece = null) {
    state.tool = tool;
    state.piece = piece;
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    document.querySelectorAll('.piece').forEach((b) => b.classList.toggle('active', !!piece && b.dataset.key === piece.key));
    viewport.setTool(tool, piece);
    $('#hud-mode').textContent = tool === 'place' ? `Place · ${piece?.label || ''}` : 'Select';
    $('#hud-hint').textContent = tool === 'place'
        ? 'Left-click a surface to place · Esc to stop placing · Right-drag to orbit'
        : 'Left-click to select · W move · E rotate · R resize · Right-drag to orbit · Middle-drag to pan';
}

// ------------------------------------------------------------------ rendering panels
function refresh() {
    viewport.sync(state.doc);
    state.selected = state.selected.filter(existsSel);
    if (state.selection && !existsSel(state.selection)) state.selection = state.selected[state.selected.length - 1] || null;
    viewport.selectMany(state.selected, state.selection);
    $('#map-name').value = state.doc.name;
    $('#btn-undo').disabled = !state.undo.length;
    $('#btn-redo').disabled = !state.redo.length;
    renderOutliner();
    renderInspector();
    renderMaterials();
    renderEnvironment();
    renderChecklist();
    autosave();
}

function itemName(kind, item, index) {
    if (kind === 'block') return `${SHAPE_LABEL[item.shape] || 'Block'} ${index + 1}`;
    if (kind === 'playerSpawns') return `${item.team === 'team1' ? 'Team 1 spawn' : item.team === 'team2' ? 'Team 2 spawn' : 'Spawn'} ${index + 1}`;
    return `${KIND_LABEL[kind]} ${index + 1}`;
}

function renderOutliner() {
    const ul = $('#outliner');
    ul.textContent = '';
    const doc = state.doc;
    let total = 0;
    const entry = (kind, item, index) => {
        total++;
        const li = document.createElement('li');
        const dot = document.createElement('span');
        dot.className = 'dot';
        if (kind === 'block') {
            const mat = doc.materials.find((m) => m.id === item.materialId);
            dot.style.background = item.collision === COLLISION.INVISIBLE ? 'transparent' : (mat?.color || '#888');
            if (item.collision === COLLISION.INVISIBLE) dot.style.border = '1px dashed var(--teleport)';
        } else dot.style.background = KIND_COLOR[kind];
        const label = document.createElement('span');
        label.className = 'name';
        label.textContent = itemName(kind, item, index);
        li.append(dot, label);
        if (kind !== 'brCircle') {
            const toggle = (flag, onIcon, offIcon, tipOn, tipOff) => {
                const on = !!item[flag];
                const b = el('button', { type: 'button', class: `icon-btn${on ? ' on' : ''}`, title: on ? tipOn : tipOff, 'aria-pressed': on ? 'true' : 'false' });
                b.innerHTML = on ? onIcon : offIcon;
                b.addEventListener('click', (e) => { e.stopPropagation(); setFlag(flag, !on, [{ kind, id: item.id }]); });
                return b;
            };
            li.append(
                toggle('hidden', ICONS.eyeOff, ICONS.eye, 'Hidden in the editor (still exported) · click to show', 'Hide in the editor'),
                toggle('locked', ICONS.lock, ICONS.unlock, 'Locked · click to unlock', 'Lock (no clicking or box-selecting in the view)'));
        }
        if (item.hidden) li.classList.add('is-hidden');
        if (state.selected.some((s) => s.kind === kind && s.id === item.id)) li.classList.add('selected');
        li.addEventListener('click', (e) => {
            const additive = e.shiftKey || e.ctrlKey || e.metaKey;
            select({ kind, id: item.id }, { additive });
            if (!additive) viewport.frameSelection();
        });
        ul.appendChild(li);
    };
    doc.playerSpawns.forEach((s, i) => entry('playerSpawns', s, i));
    doc.weaponSpawns.forEach((s, i) => entry('weaponSpawns', s, i));
    doc.teleporters.forEach((s, i) => entry('teleporters', s, i));
    doc.navNodes.forEach((s, i) => entry('navNodes', s, i));
    doc.cameraPaths.forEach((s, i) => entry('cameraPaths', s, i));
    if (doc.brCircle) entry('brCircle', { id: 'brCircle' }, 0);
    doc.blocks.forEach((b, i) => entry('block', b, i));
    $('#scene-count').textContent = total;
}

// ---- small form builders
function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') e.className = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children) if (c !== null && c !== undefined) e.append(c);
    return e;
}
let fieldSeq = 0;
function numberField(label, value, onCommit, { step = 0.1, min, max } = {}) {
    const id = `f${fieldSeq++}`;
    const input = el('input', { type: 'number', id, step, min, max, value: fmt(value) });
    input.addEventListener('change', () => { const v = parseFloat(input.value); if (Number.isFinite(v)) onCommit(v); });
    return el('label', { class: 'field', for: id }, el('span', {}, label), input);
}
function vecField(label, v, onCommit, step = 0.25) {
    const box = el('div', { class: 'vec' });
    for (const axis of ['x', 'y', 'z']) {
        const input = el('input', { type: 'number', step, value: fmt(v[axis]), 'aria-label': `${label} ${axis}` });
        input.addEventListener('change', () => { const n = parseFloat(input.value); if (Number.isFinite(n)) onCommit({ ...v, [axis]: n }); });
        box.append(el('label', {}, axis, input));
    }
    return el('div', { class: 'field' }, el('span', { class: 'field-label' }, label), box);
}
function selectField(label, value, options, onCommit) {
    const id = `f${fieldSeq++}`;
    const sel = el('select', { id });
    for (const [v, text] of options) sel.append(el('option', { value: v, selected: v === value }, text));
    sel.addEventListener('change', () => onCommit(sel.value));
    return el('label', { class: 'field', for: id }, el('span', {}, label), sel);
}
function checkField(label, value, onCommit) {
    const input = el('input', { type: 'checkbox', checked: !!value });
    input.addEventListener('change', () => onCommit(input.checked));
    return el('label', { class: 'check' }, input, label);
}
function colorField(label, value, onCommit) {
    const id = `f${fieldSeq++}`;
    const input = el('input', { type: 'color', id, value });
    input.addEventListener('change', () => onCommit(input.value));
    return el('label', { class: 'field inline', for: id }, el('span', {}, label), input);
}
const fmt = (v) => (Math.round((v ?? 0) * 1000) / 1000).toString();
const round = (v) => Math.round(v * 1000) / 1000;

function editSelected(fn) {
    const sel = state.selection;
    change((doc) => {
        const item = sel.kind === 'brCircle' ? doc.brCircle : (sel.kind === 'block' ? doc.blocks : doc[sel.kind]).find((x) => x.id === sel.id);
        if (item) fn(item, doc);
    });
}

function renderInspector() {
    const root = $('#inspector');
    root.textContent = '';
    if (state.selected.length > 1) return renderMultiInspector(root);
    const item = findSelected();
    if (!item) {
        root.append(el('p', { class: 'empty' }, 'Nothing selected. Pick a piece on the left and click in the view to place it, or click something to edit it.'));
        root.append(el('div', { class: 'card' },
            el('h3', {}, 'Shortcuts'),
            el('div', { class: 'stat-grid' },
                el('dt', {}, 'Select / place'), el('dd', {}, 'V / B'),
                el('dt', {}, 'Move / rotate / resize'), el('dd', {}, 'W / E / R'),
                el('dt', {}, 'Add to selection'), el('dd', {}, 'Shift+click / drag a box'),
                el('dt', {}, 'Select all'), el('dd', {}, 'Ctrl+A'),
                el('dt', {}, 'Copy / paste / cut'), el('dd', {}, 'Ctrl+C / V / X'),
                el('dt', {}, 'Duplicate'), el('dd', {}, 'Ctrl+D'),
                el('dt', {}, 'Turn 90°'), el('dd', {}, '[ / ]'),
                el('dt', {}, 'Hide / show all'), el('dd', {}, 'H / Shift+H'),
                el('dt', {}, 'Move the view'), el('dd', {}, 'Arrows, PgUp/PgDn'),
                el('dt', {}, 'Delete'), el('dd', {}, 'Del'),
                el('dt', {}, 'Frame selection'), el('dd', {}, 'F'),
                el('dt', {}, 'Walk test'), el('dd', {}, 'P'),
                el('dt', {}, 'Undo / redo'), el('dd', {}, 'Ctrl+Z / Ctrl+Y'))));
        return;
    }
    const kind = state.selection.kind;
    const index = kind === 'brCircle' ? 0 : listFor(kind).indexOf(item);
    root.append(el('h3', {}, el('span', { class: 'dot' }), itemName(kind, item, index)));

    if (kind === 'block') {
        root.append(selectField('Shape', item.shape, Object.entries(SHAPE_LABEL), (v) => editSelected((b) => { b.shape = v; if (v === 'stairs') b.steps ??= 6; if (v === 'cylinder') b.segments ??= 16; })));
        root.append(vecField('Position (centre)', item.position, (v) => editSelected((b) => { b.position = v; })));
        root.append(vecField('Size', item.size, (v) => editSelected((b) => { b.size = { x: Math.max(0.05, v.x), y: Math.max(0.05, v.y), z: Math.max(0.05, v.z) }; })));
        root.append(vecField('Rotation (degrees)', item.rotation, (v) => editSelected((b) => { b.rotation = v; }), 15));
        root.append(el('div', { class: 'row' },
            el('button', { type: 'button', onclick: () => editSelected((b) => { b.rotation = { ...b.rotation, y: ((b.rotation.y || 0) + 90) % 360 }; }) }, 'Turn 90°'),
            el('button', { type: 'button', onclick: () => editSelected((b) => { b.rotation = { x: 0, y: 0, z: 0 }; }) }, 'Reset rotation')));
        if (item.shape === 'stairs') root.append(numberField('Steps', item.steps ?? 6, (v) => editSelected((b) => { b.steps = Math.max(1, Math.min(64, Math.round(v))); }), { step: 1, min: 1, max: 64 }));
        if (item.shape === 'cylinder') root.append(numberField('Sides', item.segments ?? 16, (v) => editSelected((b) => { b.segments = Math.max(6, Math.min(48, Math.round(v))); }), { step: 1, min: 6, max: 48 }));
        root.append(selectField('Material', item.materialId, state.doc.materials.map((m) => [m.id, m.name]), (v) => { state.currentMaterial = v; editSelected((b) => { b.materialId = v; }); }));
        root.append(selectField('Collision', item.collision || COLLISION.SOLID, [
            [COLLISION.SOLID, 'Solid (visible, collides)'],
            [COLLISION.VISUAL, 'Decoration (visible, no collision)'],
            [COLLISION.INVISIBLE, 'Invisible wall (collides, not drawn)'],
        ], (v) => editSelected((b) => { b.collision = v; })));
        if (item.collision !== COLLISION.INVISIBLE) root.append(checkField('Casts and receives shadows', item.shadows !== false, (v) => editSelected((b) => { b.shadows = v; })));
        const tris = buildBlockTriangles(item).positions.length / 9;
        root.append(el('p', { class: 'empty' }, `${tris} triangles`));
    } else if (kind === 'playerSpawns') {
        root.append(vecField('Position (feet)', item.position, (v) => editSelected((s) => { s.position = v; })));
        root.append(numberField('Facing (degrees)', item.yaw ?? 0, (v) => editSelected((s) => { s.yaw = ((v % 360) + 360) % 360; }), { step: 15 }));
        root.append(selectField('Team', item.team || 'neutral', [['neutral', 'Everyone (free-for-all)'], ['team1', 'Team 1'], ['team2', 'Team 2']], (v) => editSelected((s) => { s.team = v; })));
    } else if (kind === 'weaponSpawns') {
        root.append(vecField('Position', item.position, (v) => editSelected((s) => { s.position = v; })));
        root.append(el('p', { class: 'empty' }, 'The game picks which weapon appears here and when.'));
    } else if (kind === 'teleporters') {
        root.append(vecField('Position', item.position, (v) => editSelected((s) => { s.position = v; })));
        root.append(numberField('Exit facing (degrees)', item.yaw ?? 0, (v) => editSelected((s) => { s.yaw = ((v % 360) + 360) % 360; }), { step: 15 }));
        root.append(numberField('Trigger radius (m)', item.radius ?? 1.5, (v) => editSelected((s) => { s.radius = Math.max(0.3, v); }), { step: 0.25, min: 0.3 }));
        root.append(linkEditor('Sends players to', item.destinations || [], state.doc.teleporters.filter((t) => t.id !== item.id), 'teleporters',
            (ids) => editSelected((s) => { s.destinations = ids; })));
        root.append(el('p', { class: 'empty' }, 'Tip: select a teleporter, then place a new one: the two are linked both ways.'));
    } else if (kind === 'navNodes') {
        root.append(vecField('Position', item.position, (v) => editSelected((s) => { s.position = v; })));
        root.append(linkEditor('Connected to', item.links || [], state.doc.navNodes.filter((n) => n.id !== item.id), 'navNodes',
            (ids) => editSelected((s) => { s.links = ids; })));
        root.append(el('p', { class: 'empty' }, 'Links work both ways in game. With “Link new nav nodes” on, each node you place connects to the selected one.'));
    } else if (kind === 'cameraPaths') {
        const part = state.selection.part;
        const pose = (label, key) => el('div', { class: 'card', style: part === key ? 'border-color: var(--accent)' : '' },
            el('div', { class: 'card-head' }, el('strong', {}, `${label} shot`),
                el('button', { type: 'button', title: 'Look through this camera and fly it into place (Enter saves)', onclick: () => frameShot(item.id, key) }, 'Frame shot'),
                el('button', { type: 'button', title: 'Move this camera with the gizmo', onclick: () => select({ kind: 'cameraPaths', id: item.id, part: key }) }, 'Move')),
            vecField('Position', item[key].position, (v) => editSelected((c) => { c[key].position = v; })),
            el('div', { class: 'row' },
                numberField('Yaw', item[key].yaw, (v) => editSelected((c) => { c[key].yaw = v; }), { step: 5 }),
                numberField('Pitch', item[key].pitch, (v) => editSelected((c) => { c[key].pitch = Math.max(-89, Math.min(89, v)); }), { step: 5 })));
        root.append(pose('Start', 'start'), pose('End', 'end'));
        root.append(numberField('Duration (seconds)', item.seconds ?? 25, (v) => editSelected((c) => { c.seconds = Math.max(1, v); }), { step: 1, min: 1 }));
        root.append(el('div', { class: 'row' },
            el('button', { type: 'button', onclick: () => viewport.playFlyover(item) }, 'Preview this path'),
            el('button', { type: 'button', onclick: playMenuLoop }, 'Play menu loop')));
        const total = state.doc.cameraPaths.reduce((s, c) => s + (c.seconds || 25), 0);
        root.append(el('p', { class: 'empty' }, `The menu camera plays each path in turn before a match (${state.doc.cameraPaths.length} paths, ${total} s loop). Most maps have about six. Frame shot: right-drag to look, WASD to move, Q/E down/up, Shift faster, scroll for speed, Enter to save.`));
        root.append(el('button', { type: 'button', onclick: generatePaths }, 'Generate 6 paths around the map'));
    } else if (kind === 'brCircle') {
        root.append(vecField('Centre', item.position, (v) => editSelected((c) => { c.position = v; })));
        root.append(numberField('Radius (m)', item.radius, (v) => editSelected((c) => { c.radius = Math.max(5, v); }), { step: 5, min: 5 }));
        root.append(el('p', { class: 'empty' }, 'Battle royale only: the safe zone starts this big and shrinks towards its centre. Match the map size; set y to the average ground height.'));
    }

    if (kind !== 'brCircle') root.append(arrangeCard());
    root.append(el('div', { class: 'row' },
        kind !== 'brCircle' ? el('button', { type: 'button', onclick: duplicateSelected }, 'Duplicate') : null,
        el('button', { type: 'button', class: 'danger', onclick: deleteSelected }, 'Delete')));
}

function linkEditor(label, ids, candidates, kind, onCommit) {
    const all = listFor(kind);
    const nameOf = (id) => { const i = all.findIndex((x) => x.id === id); return i < 0 ? null : itemName(kind, all[i], i); };
    const chips = el('div', { class: 'links' });
    for (const id of ids) {
        const name = nameOf(id);
        if (!name) continue;
        chips.append(el('span', { class: 'chip' }, name, el('button', { type: 'button', 'aria-label': `Remove ${name}`, onclick: () => onCommit(ids.filter((x) => x !== id)) }, '×')));
    }
    if (!ids.length) chips.append(el('span', { class: 'empty' }, 'None yet'));
    const add = el('select', { 'aria-label': `Add to ${label}` });
    add.append(el('option', { value: '' }, 'Add…'));
    for (const c of candidates) if (!ids.includes(c.id)) add.append(el('option', { value: c.id }, nameOf(c.id)));
    add.addEventListener('change', () => { if (add.value) onCommit([...ids, add.value]); });
    return el('div', { class: 'field' }, el('span', { class: 'field-label' }, label), chips, add);
}

const listForDoc = (doc, kind) => (kind === 'block' ? doc.blocks : doc[kind]);

function renderMaterials() {
    const root = $('#materials');
    root.textContent = '';
    root.append(el('p', { class: 'empty' }, 'New blocks use the highlighted material. Fewer materials keep the map fast (ev.io maps average about two per object).'));
    for (const m of state.doc.materials) {
        const count = state.doc.blocks.filter((b) => b.materialId === m.id).length;
        const name = el('input', { type: 'text', value: m.name, 'aria-label': 'Material name' });
        name.addEventListener('change', () => change((doc) => { doc.materials.find((x) => x.id === m.id).name = name.value || 'Material'; }));
        const color = el('input', { type: 'color', value: m.color, 'aria-label': `${m.name} colour` });
        color.addEventListener('change', () => change((doc) => { doc.materials.find((x) => x.id === m.id).color = color.value; }));
        const card = el('div', { class: 'card', style: state.currentMaterial === m.id ? 'border-color: var(--accent)' : '' },
            el('div', { class: 'card-head' }, color, name),
            el('div', { class: 'row' },
                numberField('Roughness', m.roughness ?? 0.5, (v) => change((doc) => { doc.materials.find((x) => x.id === m.id).roughness = clamp01(v); }), { step: 0.05, min: 0, max: 1 }),
                numberField('Opacity', m.opacity ?? 1, (v) => change((doc) => { doc.materials.find((x) => x.id === m.id).opacity = clamp01(v); }), { step: 0.05, min: 0, max: 1 })),
            colorField('Glow colour', m.emissive || '#000000', (v) => change((doc) => { doc.materials.find((x) => x.id === m.id).emissive = v; })),
            el('div', { class: 'row' },
                el('button', { type: 'button', onclick: () => { state.currentMaterial = m.id; renderMaterials(); toast(`New blocks use ${m.name}`); } }, state.currentMaterial === m.id ? 'In use for new blocks' : 'Use for new blocks'),
                state.selection?.kind === 'block' ? el('button', { type: 'button', onclick: () => editSelected((b) => { b.materialId = m.id; }) }, 'Apply to selected') : null),
            el('span', { class: 'empty' }, `${count} block${count === 1 ? '' : 's'}`));
        root.append(card);
    }
    root.append(el('button', { type: 'button', onclick: () => change((doc) => { const id = newId('mat'); doc.materials.push({ id, name: `Material ${doc.materials.length + 1}`, color: '#8899aa', roughness: 0.7 }); state.currentMaterial = id; }) }, 'Add material'));
}
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function renderEnvironment() {
    const root = $('#environment');
    root.textContent = '';
    const env = state.doc.environment;
    const setEnv = (key) => (v) => change((doc) => { doc.environment[key] = v; });
    root.append(el('div', { class: 'card' }, el('strong', {}, 'Sky'),
        colorField('Top', env.skyTop, setEnv('skyTop')),
        colorField('Horizon', env.skyHorizon, setEnv('skyHorizon')),
        colorField('Bottom', env.skyBottom, setEnv('skyBottom'))));
    root.append(el('div', { class: 'card' }, el('strong', {}, 'Fog'),
        colorField('Colour', env.fogColor, setEnv('fogColor')),
        numberField('Density (0 = off)', env.fogDensity, (v) => setEnv('fogDensity')(Math.max(0, v)), { step: 0.001, min: 0 }),
        numberField('View distance (m)', env.farPlane, (v) => setEnv('farPlane')(Math.max(100, v)), { step: 50, min: 100 })));
    root.append(el('div', { class: 'card' }, el('strong', {}, 'Ambient light'),
        colorField('From the sky', env.hemiSky, setEnv('hemiSky')),
        colorField('From the ground', env.hemiGround, setEnv('hemiGround')),
        numberField('Strength', env.hemiIntensity, (v) => setEnv('hemiIntensity')(Math.max(0, v)), { step: 0.05, min: 0 }),
        numberField('Shadow darkness (0–1)', env.shadowStrength, (v) => setEnv('shadowStrength')(clamp01(v)), { step: 0.05, min: 0, max: 1 })));
    root.append(el('h3', {}, 'Sun lights'));
    root.append(el('p', { class: 'empty' }, 'Use two or three. Only one may cast shadows; without lights the map renders black.'));
    state.doc.lights.forEach((l, i) => {
        const setL = (key) => (v) => change((doc) => { doc.lights[i][key] = v; if (key === 'castsShadow' && v) doc.lights.forEach((o, j) => { if (j !== i) o.castsShadow = false; }); });
        root.append(el('div', { class: 'card' },
            el('div', { class: 'card-head' }, el('strong', {}, `Light ${i + 1}`), el('button', { type: 'button', class: 'danger', onclick: () => change((doc) => { doc.lights.splice(i, 1); }) }, 'Remove')),
            colorField('Colour', l.color, setL('color')),
            el('div', { class: 'row' },
                numberField('Strength', l.intensity, (v) => setL('intensity')(Math.max(0, v)), { step: 0.05, min: 0 }),
                numberField('Compass (°)', l.yaw, (v) => setL('yaw')(((v % 360) + 360) % 360), { step: 5 }),
                numberField('Height (°)', l.pitch, (v) => setL('pitch')(Math.max(1, Math.min(90, v))), { step: 5, min: 1, max: 90 })),
            checkField('Casts shadows', l.castsShadow, setL('castsShadow'))));
    });
    if (state.doc.lights.length < 4) root.append(el('button', { type: 'button', onclick: () => change((doc) => { doc.lights.push({ id: newId('light'), color: '#ffffff', intensity: 0.4, yaw: 0, pitch: 45, castsShadow: false }); }) }, 'Add light'));
}

function renderChecklist() {
    const issues = validate(state.doc);
    if (state.doc.navNodes.length) {
        const nav = navReport(state.doc);
        if (nav.unreachableSpawns.length) issues.push({ level: 'warn', text: `Bots cannot reach ${spawnNames(nav.unreachableSpawns)} (no nav node nearby in the main area).` });
        if (nav.areas > 1) issues.push({ level: 'warn', text: `The nav graph has ${nav.areas} separate areas: bots cannot travel between them.` });
    } else {
        const i = issues.findIndex((x) => /nav nodes/.test(x.text));
        if (i >= 0) issues[i] = { level: 'warn', text: 'No bot nav nodes: bots will stand still. Auto nav (Gameplay) can generate them.' };
    }
    const errors = issues.filter((i) => i.level === 'error').length;
    const badge = $('#issue-count');
    badge.textContent = issues.length || '';
    badge.className = `badge ${errors ? 'error' : issues.length ? 'warn' : ''}`;
    const root = $('#checklist');
    root.textContent = '';
    const ul = el('ul', { class: 'issues' });
    if (!issues.length) ul.append(el('li', { class: 'ok' }, 'Everything on ev.io’s submission checklist is covered.'));
    for (const i of issues) ul.append(el('li', { class: i.level }, i.text));
    root.append(ul);
    const tris = state.doc.blocks.reduce((s, b) => s + buildBlockTriangles(b).positions.length / 9, 0);
    root.append(el('dl', { class: 'stat-grid' },
        el('dt', {}, 'Blocks'), el('dd', {}, state.doc.blocks.length),
        el('dt', {}, 'Triangles'), el('dd', {}, tris.toLocaleString()),
        el('dt', {}, 'Player spawns'), el('dd', {}, state.doc.playerSpawns.length),
        el('dt', {}, 'Weapon spawns'), el('dd', {}, state.doc.weaponSpawns.length),
        el('dt', {}, 'Nav nodes'), el('dd', {}, state.doc.navNodes.length),
        el('dt', {}, 'Camera paths'), el('dd', {}, state.doc.cameraPaths.length)));
    root.append(el('p', { class: 'empty' }, 'Keep the map above the kill zone at y = −30 (the red plane): anything that falls below it dies.'));
}

function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-body').forEach((b) => { b.hidden = b.dataset.body !== tab; });
}

// ------------------------------------------------------------------ files
function slug(name) { return (name || 'map').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'map'; }
function download(bytes, filename, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = el('a', { href: url, download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function saveProject() {
    download(JSON.stringify(state.doc, null, 1), `${slug(state.doc.name)}.mapproject.json`, 'application/json');
    toast('Project saved');
}
function openProject(file) {
    const reader = new FileReader();
    reader.onload = () => {
        try {
            const doc = normaliseDocument(JSON.parse(reader.result));
            state.undo.push(JSON.stringify(state.doc));
            state.doc = doc;
            state.selection = null;
            refresh();
            toast(`Opened ${doc.name}`);
        } catch (e) {
            toast('That file is not an EV.IO Map Editor project (.mapproject.json).');
        }
    };
    reader.readAsText(file);
}

let lastExport = null;
function openExport() {
    const body = $('#export-body');
    body.textContent = '';
    const issues = validate(state.doc);
    try {
        const compiled = compileDocument(state.doc);
        const bytes = writeEvmap(compiled);
        lastExport = bytes;
        const mb = bytes.length / (1024 * 1024);
        const tris = compiled.meshes.reduce((s, m) => s + m.submeshes.reduce((t, sm) => t + sm.indexBuffer.length / 3, 0), 0);
        body.append(el('dl', { class: 'stat-grid' },
            el('dt', {}, 'File size'), el('dd', {}, mb >= 0.1 ? `${mb.toFixed(2)} MB` : `${(bytes.length / 1024).toFixed(1)} KB`),
            el('dt', {}, 'Objects (after merging)'), el('dd', {}, compiled.rootObject.children.length),
            el('dt', {}, 'Triangles'), el('dd', {}, tris.toLocaleString()),
            el('dt', {}, 'Materials'), el('dd', {}, compiled.materials.length)));
        if (mb > 10) issues.unshift({ level: 'error', text: 'Over ev.io’s 10 MB map limit.' });
        $('#export-download').disabled = false;
    } catch (e) {
        lastExport = null;
        issues.unshift({ level: 'error', text: e.message });
        $('#export-download').disabled = true;
    }
    const ul = el('ul', { class: 'issues' });
    if (!issues.length) ul.append(el('li', { class: 'ok' }, 'Ready to upload.'));
    for (const i of issues) ul.append(el('li', { class: i.level }, i.text));
    body.append(ul);
    body.append(el('p', { class: 'empty' }, 'Upload at ev.io/node/add/map with a 166×70 PNG thumbnail and a 2000×902 JPEG large image. Until ev.io staff approve it, you can play it on a custom server.'));
    $('#export-dialog').showModal();
}

// ------------------------------------------------------------------ export images
// ev.io's upload form (ev.io/node/add/map) wants a 166×70 PNG thumbnail and a 2000×902 JPEG large
// image. Both are rendered from the map itself; the thumbnail is supersampled 4× so it stays crisp.
const IMAGE_SPECS = {
    large: { width: 2000, height: 902, type: 'image/jpeg', quality: 0.9, ext: 'jpg', supersample: 1 },
    thumb: { width: 166, height: 70, type: 'image/png', ext: 'png', supersample: 4 },
};
const images = { large: null, thumb: null };

function imageViews() {
    const views = [{ value: 'view', label: 'The current view', pose: null }];
    state.doc.cameraPaths.forEach((c, i) => {
        views.push({ value: `cam${i}s`, label: `Camera path ${i + 1}, start`, pose: c.start });
        views.push({ value: `cam${i}e`, label: `Camera path ${i + 1}, end`, pose: c.end });
    });
    return views;
}

function canvasToBlob(canvas, spec) {
    return new Promise((resolve) => canvas.toBlob(resolve, spec.type, spec.quality));
}

async function renderImages() {
    const views = imageViews();
    const chosen = views.find((v) => v.value === $('#images-view').value) || views[0];
    for (const key of ['large', 'thumb']) {
        const spec = IMAGE_SPECS[key];
        const canvas = viewport.renderStill(spec.width, spec.height, chosen.pose, spec.supersample);
        const blob = await canvasToBlob(canvas, spec);
        if (images[key]) URL.revokeObjectURL(images[key].url);
        images[key] = { blob, url: URL.createObjectURL(blob) };
        $(`#${key}-preview`).src = images[key].url;
        $(`#${key}-size`).textContent = blob.size >= 1024 * 1024 ? `${(blob.size / 1048576).toFixed(2)} MB` : `${Math.round(blob.size / 1024)} KB`;
    }
}

function openImages() {
    const sel = $('#images-view');
    const previous = sel.value;
    sel.textContent = '';
    const views = imageViews();
    for (const v of views) sel.append(el('option', { value: v.value }, v.label));
    // Default to the first camera path's start: it is the view players get in the menu.
    sel.value = views.some((v) => v.value === previous) ? previous : (views[1]?.value || 'view');
    $('#images-dialog').showModal();
    renderImages().catch((e) => toast(`Could not render the images: ${e.message}`));
}

function downloadImage(key) {
    const img = images[key];
    if (!img) return;
    const spec = IMAGE_SPECS[key];
    download(img.blob, `${slug(state.doc.name)}-${key === 'large' ? 'large' : 'thumbnail'}-${spec.width}x${spec.height}.${spec.ext}`, spec.type);
}

// ------------------------------------------------------------------ bot nav nodes
function openNavDialog() {
    $('#nav-result').textContent = '';
    $('#nav-replace').checked = true;
    $('#nav-dialog').showModal();
}
function runNavGeneration() {
    const spacing = parseFloat($('#nav-spacing').value) || 4;
    const replaceAll = $('#nav-replace').checked;
    const t0 = performance.now();
    const { nodes, stats } = generateNavNodes(state.doc, { spacing });
    const ms = Math.round(performance.now() - t0);
    const out = $('#nav-result');
    out.textContent = '';
    if (!nodes.length) {
        out.append(el('ul', { class: 'issues' }, el('li', { class: 'error' }, 'No walkable floor found. Add solid blocks to stand on first.')));
        return;
    }
    change((doc) => { doc.navNodes = replaceAll ? nodes : [...doc.navNodes, ...nodes]; });
    select(null);
    const report = navReport(state.doc);
    const items = [el('li', { class: 'ok' }, `${stats.nodes} nodes and ${stats.links} links in ${ms} ms.`)];
    if (report.areas > 1) items.push(el('li', { class: 'warn' }, `The graph has ${report.areas} separate areas. Bots cannot travel between them; connect them with a ramp or stairs, or delete stray islands.`));
    if (report.unreachableSpawns.length) items.push(el('li', { class: 'warn' }, `Bots cannot reach ${spawnNames(report.unreachableSpawns)}.`));
    out.append(el('ul', { class: 'issues' }, ...items));
    toast(`Generated ${stats.nodes} nav nodes`);
}
function spawnNames(indices) {
    const names = indices.map((i) => itemName('playerSpawns', state.doc.playerSpawns[i], i));
    return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

// ------------------------------------------------------------------ toast
let toastTimer;
function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ------------------------------------------------------------------ wiring
function buildPalettes() {
    const blocks = $('#palette-blocks');
    for (const p of BLOCK_PIECES) {
        const piece = { kind: 'block', key: `b:${p.label}`, ...p };
        const round = p.shape === 'cylinder';
        blocks.append(el('button', { type: 'button', class: 'piece', 'data-key': piece.key, title: `${p.label} (${p.size.x}×${p.size.y}×${p.size.z} m)`, onclick: () => setTool('place', piece) },
            el('span', { class: `swatch shape${round ? ' round' : ''}` }), p.label));
    }
    const objs = $('#palette-objects');
    for (const p of OBJECT_PIECES) {
        const piece = { kind: 'object', key: `o:${p.label}`, ...p };
        const sw = el('span', { class: 'swatch round' });
        sw.style.background = p.color;
        objs.append(el('button', { type: 'button', class: 'piece', 'data-key': piece.key, title: p.title, onclick: () => (p.instant ? addInstantPiece(p) : setTool('place', piece)) }, sw, p.label));
    }
}

function bindUi() {
    document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => {
        if (b.dataset.tool === 'place') setTool('place', state.piece || { kind: 'block', key: 'b:Box', ...BLOCK_PIECES[0] });
        else setTool('select');
    }));
    document.querySelectorAll('[data-gizmo]').forEach((b) => b.addEventListener('click', () => setGizmo(b.dataset.gizmo)));
    document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
    $('#grid-size').addEventListener('change', (e) => viewport.setGrid(parseFloat(e.target.value)));
    $('#map-name').addEventListener('change', (e) => change((doc) => { doc.name = e.target.value.trim() || 'Untitled map'; }));
    $('#btn-new').addEventListener('click', () => {
        if (!confirm('Start a new map? Unsaved changes stay in undo history until you reload.')) return;
        change((doc) => Object.assign(doc, newDocument()));
        select(null);
    });
    $('#btn-open').addEventListener('click', () => $('#file-input').click());
    $('#file-input').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) openProject(f); e.target.value = ''; });
    $('#btn-save').addEventListener('click', saveProject);
    $('#btn-undo').addEventListener('click', undo);
    $('#btn-redo').addEventListener('click', redo);
    $('#btn-export').addEventListener('click', openExport);
    $('#btn-images').addEventListener('click', openImages);
    $('#nav-generate').addEventListener('click', runNavGeneration);
    $('#btn-walk').addEventListener('click', startWalkTest);
    $('#walk-exit').addEventListener('click', () => viewport.endWalk());
    $('#frame-save').addEventListener('click', () => viewport.endFraming(true));
    $('#frame-cancel').addEventListener('click', () => viewport.endFraming(false));
    $('#work-light').addEventListener('change', (e) => viewport.setWorkLight(e.target.checked));
    $('#images-view').addEventListener('change', () => renderImages().catch((e) => toast(`Could not render the images: ${e.message}`)));
    $('#download-thumb').addEventListener('click', () => downloadImage('thumb'));
    $('#download-large').addEventListener('click', () => downloadImage('large'));
    $('#export-download').addEventListener('click', () => { if (lastExport) { download(lastExport, `${slug(state.doc.name)}.evmap`, 'application/octet-stream'); toast('Exported .evmap'); } });

    const typingNow = () => /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
    document.addEventListener('copy', (e) => {
        if (typingNow() || !state.selected.length) return;
        const text = copySelection();
        if (text) { e.clipboardData.setData('text/plain', text); e.preventDefault(); }
    });
    document.addEventListener('cut', (e) => {
        if (typingNow() || !state.selected.length) return;
        const text = copySelection();
        if (text) { e.clipboardData.setData('text/plain', text); e.preventDefault(); deleteSelected(); }
    });
    document.addEventListener('paste', (e) => {
        if (typingNow()) return;
        e.preventDefault();
        pasteText(e.clipboardData.getData('text/plain'));
    });

    window.addEventListener('keydown', (e) => {
        const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
        const mod = e.ctrlKey || e.metaKey;
        if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { if (!typing) { e.preventDefault(); undo(); } return; }
        if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { if (!typing) { e.preventDefault(); redo(); } return; }
        if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); return; }
        if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
        if (mod && e.key.toLowerCase() === 'a' && !typing) { e.preventDefault(); selectAll(); return; }
        if (typing || mod) return;
        const k = e.key.toLowerCase();
        if (k === 'v') setTool('select');
        else if (k === 'b') setTool('place', state.piece || { kind: 'block', key: 'b:Box', ...BLOCK_PIECES[0] });
        else if (k === 'w') setGizmo('translate');
        else if (k === 'e') setGizmo('rotate');
        else if (k === 'r') setGizmo('scale');
        else if (k === 'f') viewport.frameSelection();
        else if (k === 'p') startWalkTest();
        else if (e.key === '[') rotateSelection(90);
        else if (e.key === ']') rotateSelection(-90);
        else if (k === 'h' && e.shiftKey) showAll();
        else if (k === 'h') setFlag('hidden', true);
        else if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSelected(); }
        else if (k === 'escape') {
            // Esc first stops a playing camera preview; only a second Esc stops placing or deselects.
            if (viewport.flyover) { viewport.stopFlyover(); toast('Camera preview stopped'); }
            else if (state.tool === 'place') setTool('select');
            else select(null);
        }
    });
}
function setGizmo(mode) {
    document.querySelectorAll('[data-gizmo]').forEach((b) => b.classList.toggle('active', b.dataset.gizmo === mode));
    viewport.setGizmoMode(mode);
}

// For the browser tests and the devtools console.
window.__mapEditor = { state, viewport };

buildPalettes();
bindUi();
setTool('select');
refresh();
