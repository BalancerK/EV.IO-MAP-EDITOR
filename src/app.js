// EV.IO Map Editor — application state, panels and file handling. The document (src/model/document.js)
// is the single source of truth; every edit goes through change(), which records undo history,
// re-renders and autosaves.
import { Viewport } from './editor/viewport.js';
import { newDocument, normaliseDocument, newId, validate, COLLISION, TEAMS } from './model/document.js';
import { compileDocument } from './model/compile.js';
import { buildBlockTriangles } from './model/geometry.js';
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
    { label: 'Camera', type: 'cameraPaths', color: 'var(--camera)', instant: true },
    { label: 'BR circle', type: 'brCircle', color: 'var(--teleport)', instant: true },
];
const KIND_LABEL = { block: 'Block', playerSpawns: 'Player spawn', weaponSpawns: 'Weapon spawn', teleporters: 'Teleporter', navNodes: 'Nav node', cameraPaths: 'Camera path', brCircle: 'Battle royale circle' };
const KIND_COLOR = { playerSpawns: 'var(--spawn)', weaponSpawns: 'var(--weapon)', teleporters: 'var(--teleport)', navNodes: 'var(--nav)', cameraPaths: 'var(--camera)', brCircle: 'var(--teleport)' };
const SHAPE_LABEL = { box: 'Box', ramp: 'Ramp', stairs: 'Stairs', cylinder: 'Cylinder', 'wedge-corner': 'Corner wedge' };

// ------------------------------------------------------------------ state
const state = {
    doc: loadAutosave() || newDocument(),
    selection: null,
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
    onSelect(sel) { select(sel); },
    onPlace(pos) { placePiece(pos); },
    onTransform(sel, t) {
        change((doc) => {
            if (sel.kind === 'block') {
                const b = doc.blocks.find((x) => x.id === sel.id);
                if (b) Object.assign(b, { position: t.position, rotation: t.rotation, size: t.size });
            } else if (sel.kind === 'brCircle') {
                doc.brCircle.position = t.delta;
            } else if (sel.kind !== 'cameraPaths') {
                const item = (doc[sel.kind] || []).find((x) => x.id === sel.id);
                if (item) item.position = t.delta;
            }
        });
    },
    onHover(p) { $('#hud-coords').textContent = `x ${p.x.toFixed(1)}  y ${p.y.toFixed(1)}  z ${p.z.toFixed(1)}`; },
    onFlyoverEnd() { toast('Camera preview finished'); },
});

function select(sel) {
    state.selection = sel;
    viewport.select(sel);
    if (sel) setTab('inspector');
    renderOutliner();
    renderInspector();
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
    viewport.select(created);
    renderOutliner();
    renderInspector();
}

function addInstantPiece(p) {
    if (p.type === 'cameraPaths') {
        const pose = viewport.viewPose();
        const end = { position: { x: pose.position.x + 20, y: pose.position.y, z: pose.position.z }, yaw: pose.yaw, pitch: pose.pitch };
        let id;
        change((doc) => { id = newId('cam'); doc.cameraPaths.push({ id, start: pose, end, seconds: 25 }); });
        select({ kind: 'cameraPaths', id });
        toast('Camera path added from the current view');
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
    viewport.select(state.selection);
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
        label.textContent = itemName(kind, item, index);
        li.append(dot, label);
        if (state.selection && state.selection.kind === kind && state.selection.id === item.id) li.classList.add('selected');
        li.addEventListener('click', () => { select({ kind, id: item.id }); viewport.frameSelection(); });
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
    const item = findSelected();
    if (!item) {
        root.append(el('p', { class: 'empty' }, 'Nothing selected. Pick a piece on the left and click in the view to place it, or click something to edit it.'));
        root.append(el('div', { class: 'card' },
            el('h3', {}, 'Shortcuts'),
            el('div', { class: 'stat-grid' },
                el('dt', {}, 'Select / place'), el('dd', {}, 'V / B'),
                el('dt', {}, 'Move / rotate / resize'), el('dd', {}, 'W / E / R'),
                el('dt', {}, 'Duplicate'), el('dd', {}, 'Ctrl+D'),
                el('dt', {}, 'Delete'), el('dd', {}, 'Del'),
                el('dt', {}, 'Frame selection'), el('dd', {}, 'F'),
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
        const pose = (label, key) => el('div', { class: 'card' },
            el('div', { class: 'card-head' }, el('strong', {}, label),
                el('button', { type: 'button', onclick: () => { const p = viewport.viewPose(); editSelected((c) => { c[key] = p; }); toast(`${label} set from the view`); } }, 'Use current view')),
            vecField('Position', item[key].position, (v) => editSelected((c) => { c[key].position = v; })),
            el('div', { class: 'row' },
                numberField('Yaw', item[key].yaw, (v) => editSelected((c) => { c[key].yaw = v; }), { step: 5 }),
                numberField('Pitch', item[key].pitch, (v) => editSelected((c) => { c[key].pitch = Math.max(-89, Math.min(89, v)); }), { step: 5 })));
        root.append(pose('Start', 'start'), pose('End', 'end'));
        root.append(numberField('Duration (seconds)', item.seconds ?? 25, (v) => editSelected((c) => { c.seconds = Math.max(1, v); }), { step: 1, min: 1 }));
        root.append(el('button', { type: 'button', onclick: () => viewport.playFlyover(item) }, 'Preview this camera move'));
        root.append(el('p', { class: 'empty' }, 'The menu camera plays each path in turn before a match. Most maps have about six.'));
    } else if (kind === 'brCircle') {
        root.append(vecField('Centre', item.position, (v) => editSelected((c) => { c.position = v; })));
        root.append(numberField('Radius (m)', item.radius, (v) => editSelected((c) => { c.radius = Math.max(5, v); }), { step: 5, min: 5 }));
        root.append(el('p', { class: 'empty' }, 'Battle royale only: the safe zone starts this big and shrinks towards its centre. Match the map size; set y to the average ground height.'));
    }

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

function duplicateSelected() {
    const sel = state.selection;
    const item = findSelected();
    if (!item || sel.kind === 'brCircle') return;
    const copy = JSON.parse(JSON.stringify(item));
    copy.id = newId(sel.kind === 'block' ? 'blk' : 'obj');
    const shift = sel.kind === 'block' ? Math.max(viewport.grid, item.size.x) : viewport.grid * 2;
    if (copy.position) copy.position = { ...copy.position, x: round(copy.position.x + shift) };
    if (sel.kind === 'cameraPaths') { copy.start.position.x += 5; copy.end.position.x += 5; }
    if (copy.links) copy.links = [];
    if (copy.destinations) copy.destinations = [];
    change((doc) => { listForDoc(doc, sel.kind).push(copy); });
    select({ kind: sel.kind, id: copy.id });
}
function deleteSelected() {
    const sel = state.selection;
    if (!sel) return;
    change((doc) => {
        if (sel.kind === 'brCircle') { doc.brCircle = null; return; }
        const list = listForDoc(doc, sel.kind);
        const i = list.findIndex((x) => x.id === sel.id);
        if (i >= 0) list.splice(i, 1);
        for (const n of doc.navNodes) n.links = (n.links || []).filter((id) => id !== sel.id);
        for (const t of doc.teleporters) t.destinations = (t.destinations || []).filter((id) => id !== sel.id);
    });
    select(null);
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
        objs.append(el('button', { type: 'button', class: 'piece', 'data-key': piece.key, onclick: () => (p.instant ? addInstantPiece(p) : setTool('place', piece)) }, sw, p.label));
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
    $('#export-download').addEventListener('click', () => { if (lastExport) { download(lastExport, `${slug(state.doc.name)}.evmap`, 'application/octet-stream'); toast('Exported .evmap'); } });

    window.addEventListener('keydown', (e) => {
        const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
        const mod = e.ctrlKey || e.metaKey;
        if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { if (!typing) { e.preventDefault(); undo(); } return; }
        if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { if (!typing) { e.preventDefault(); redo(); } return; }
        if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); return; }
        if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
        if (typing || mod) return;
        const k = e.key.toLowerCase();
        if (k === 'v') setTool('select');
        else if (k === 'b') setTool('place', state.piece || { kind: 'block', key: 'b:Box', ...BLOCK_PIECES[0] });
        else if (k === 'w') setGizmo('translate');
        else if (k === 'e') setGizmo('rotate');
        else if (k === 'r') setGizmo('scale');
        else if (k === 'f') viewport.frameSelection();
        else if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSelected(); }
        else if (k === 'escape') { viewport.stopFlyover(); if (state.tool === 'place') setTool('select'); else select(null); }
    });
}
function setGizmo(mode) {
    document.querySelectorAll('[data-gizmo]').forEach((b) => b.classList.toggle('active', b.dataset.gizmo === mode));
    viewport.setGizmoMode(mode);
}

buildPalettes();
bindUi();
setTool('select');
refresh();
