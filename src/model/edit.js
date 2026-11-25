// Pure editing operations on the document: copy/paste with link remapping, rotating and mirroring
// selections. No three.js and no DOM, so they are unit-tested in Node (tests/test_edit.js).
import { rotationMatrix } from './geometry.js';
import { newId } from './document.js';

export const LIST_KINDS = ['blocks', 'models', 'playerSpawns', 'weaponSpawns', 'teleporters', 'navNodes', 'cameraPaths'];
export const kindToList = (kind) => (kind === 'block' ? 'blocks' : kind);
export const listToKind = (list) => (list === 'blocks' ? 'block' : list);
const ID_PREFIX = { blocks: 'blk', models: 'mdl', playerSpawns: 'spawn', weaponSpawns: 'wpn', teleporters: 'tp', navNodes: 'nav', cameraPaths: 'cam' };
const r3 = (v) => Math.round(v * 1000) / 1000;
const wrap360 = (a) => r3(((a % 360) + 360) % 360);

/** The items a selection refers to, grouped by document list (deep copies). */
export function collect(doc, selection) {
    const out = {};
    for (const s of selection) {
        const list = kindToList(s.kind);
        if (!LIST_KINDS.includes(list)) continue;
        const item = (doc[list] || []).find((x) => x.id === s.id);
        if (!item) continue;
        (out[list] ||= []).push(JSON.parse(JSON.stringify(item)));
    }
    return out;
}

/** Give copied items fresh ids; keep links between copied items, drop links leaving the copy. */
export function remapIds(groups) {
    const map = new Map();
    for (const [list, items] of Object.entries(groups)) for (const it of items) map.set(it.id, newId(ID_PREFIX[list] || 'obj'));
    const out = {};
    for (const [list, items] of Object.entries(groups)) {
        out[list] = items.map((it) => {
            const c = { ...JSON.parse(JSON.stringify(it)), id: map.get(it.id) };
            if (Array.isArray(c.links)) c.links = c.links.filter((id) => map.has(id)).map((id) => map.get(id));
            if (Array.isArray(c.destinations)) c.destinations = c.destinations.filter((id) => map.has(id)).map((id) => map.get(id));
            delete c.hidden; delete c.locked;
            return c;
        });
    }
    return out;
}

/** Every point-like position an item has (cameras have two). */
function positionsOf(list, item) {
    if (list === 'cameraPaths') return [item.start.position, item.end.position];
    return [item.position];
}

export function centreOf(groups) {
    let x = 0, y = 0, z = 0, n = 0;
    for (const [list, items] of Object.entries(groups)) for (const it of items) for (const p of positionsOf(list, it)) { x += p.x; y += p.y; z += p.z; n++; }
    return n ? { x: x / n, y: y / n, z: z / n } : { x: 0, y: 0, z: 0 };
}

// An imported piece with a sheared transform keeps its exact matrix; keep its translation in step
// with `position` and apply rotations and mirrors to the matrix itself.
const syncMatrix = (it) => { if (it.matrix) it.matrix.t = [it.position.x, it.position.y, it.position.z]; };
const premul = (it, r) => { if (it.matrix) it.matrix.m = mul3(r, it.matrix.m); };

/** Move every item by d (in place). */
export function translate(groups, d) {
    for (const [list, items] of Object.entries(groups)) for (const it of items) {
        for (const p of positionsOf(list, it)) { p.x = r3(p.x + d.x); p.y = r3(p.y + d.y); p.z = r3(p.z + d.z); }
        if (list === 'models') syncMatrix(it);
    }
    return groups;
}

/**
 * Turn every item by `degrees` around the vertical axis through `pivot` (in place). Positions orbit
 * the pivot; blocks gain the turn in their own rotation (as an extra yaw applied in world space);
 * spawns, teleporters and camera shots gain it in their facing.
 */
export function rotateY(groups, degrees, pivot) {
    const a = degrees * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const orbit = (p) => {
        const dx = p.x - pivot.x, dz = p.z - pivot.z;
        // Same sense as THREE's rotation.y: x' = x cos + z sin, z' = -x sin + z cos.
        p.x = r3(pivot.x + dx * c + dz * s);
        p.z = r3(pivot.z - dx * s + dz * c);
    };
    for (const [list, items] of Object.entries(groups)) for (const it of items) {
        for (const p of positionsOf(list, it)) orbit(p);
        if (list === 'blocks') it.rotation = eulerXYZFromMatrix(mul3(rotationMatrix({ x: 0, y: degrees, z: 0 }), rotationMatrix(it.rotation)));
        else if (list === 'models') {
            const ry = rotationMatrix({ x: 0, y: degrees, z: 0 });
            it.rotation = eulerXYZFromMatrix(mul3(ry, rotationMatrix(it.rotation)));
            premul(it, ry); syncMatrix(it);
        }
        else if (list === 'cameraPaths') { it.start.yaw = wrap360(it.start.yaw + degrees); it.end.yaw = wrap360(it.end.yaw + degrees); }
        else if ('yaw' in it) it.yaw = wrap360((it.yaw || 0) + degrees);
    }
    return groups;
}

/**
 * Mirror every item across the plane x = plane (axis 'x', left↔right) or z = plane (axis 'z',
 * front↔back), in place. A reflection is not a rotation, so a block's orientation becomes S·R·S
 * (S = the reflection through x), which reproduces the mirrored shape exactly for shapes that are
 * symmetric in their own x (box, ramp, stairs, cylinder); front↔back adds a half turn. The corner wedge is not, so its mirror is that
 * reflection followed by a quarter turn in its own frame (its rising corner moves from +x to -x).
 * Facings follow the mirrored forward direction. swapTeams swaps team 1 and team 2 spawns.
 */
export function mirror(groups, axis, plane, { swapTeams = false } = {}) {
    const flipPos = (p) => { if (axis === 'x') p.x = r3(2 * plane - p.x); else p.z = r3(2 * plane - p.z); };
    // Forward (-sin y, -cos y): mirroring x negates x -> yaw becomes -yaw; mirroring z -> 180 - yaw.
    const flipYaw = (y) => wrap360(axis === 'x' ? -(y || 0) : 180 - (y || 0));
    // Every shape is symmetric in its own x, so reflect through x: S·R·S. A front↔back mirror is
    // that same reflection followed by a half turn about the vertical (S_z = Ry(180)·S_x).
    const SX = [-1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (const [list, items] of Object.entries(groups)) for (const it of items) {
        for (const p of positionsOf(list, it)) flipPos(p);
        if (list === 'blocks') {
            let m = mul3(mul3(SX, rotationMatrix(it.rotation)), SX);
            if (it.shape === 'wedge-corner') m = mul3(m, rotationMatrix({ x: 0, y: -90, z: 0 }));
            if (axis === 'z') m = mul3(rotationMatrix({ x: 0, y: 180, z: 0 }), m);
            it.rotation = eulerXYZFromMatrix(m);
            if (it.shape === 'wedge-corner') it.size = { x: it.size.z, y: it.size.y, z: it.size.x };
        } else if (list === 'models') {
            // Reflect the world: S·R·D = (S·R·S)·(S·D), a rotation and the same scale with one axis negated.
            const S = axis === 'x' ? SX : [1, 0, 0, 0, 1, 0, 0, 0, -1];
            it.rotation = eulerXYZFromMatrix(mul3(mul3(S, rotationMatrix(it.rotation)), S));
            it.scale = axis === 'x' ? { ...it.scale, x: -it.scale.x } : { ...it.scale, z: -it.scale.z };
            premul(it, S); syncMatrix(it);
        } else if (list === 'cameraPaths') {
            it.start.yaw = flipYaw(it.start.yaw); it.end.yaw = flipYaw(it.end.yaw);
        } else if ('yaw' in it) {
            it.yaw = flipYaw(it.yaw);
        }
        if (swapTeams && list === 'playerSpawns') {
            if (it.team === 'team1') it.team = 'team2'; else if (it.team === 'team2') it.team = 'team1';
        }
    }
    return groups;
}

/** Add groups of items to the document; returns the selection entries for them. */
export function insert(doc, groups) {
    const sel = [];
    for (const [list, items] of Object.entries(groups)) {
        if (!LIST_KINDS.includes(list)) continue;
        doc[list] ||= [];
        for (const it of items) { doc[list].push(it); sel.push({ kind: listToKind(list), id: it.id }); }
    }
    return sel;
}

/** Replace items in the document with edited copies (same ids). */
export function replace(doc, groups) {
    for (const [list, items] of Object.entries(groups)) {
        for (const it of items) {
            const i = doc[list].findIndex((x) => x.id === it.id);
            if (i >= 0) doc[list][i] = it;
        }
    }
}

/** Remove the selected items, and any links pointing at them. */
export function removeSelection(doc, selection) {
    const ids = new Set(selection.map((s) => s.id));
    for (const list of LIST_KINDS) doc[list] = (doc[list] || []).filter((x) => !ids.has(x.id));
    for (const n of doc.navNodes) n.links = (n.links || []).filter((id) => !ids.has(id));
    for (const t of doc.teleporters) t.destinations = (t.destinations || []).filter((id) => !ids.has(id));
    if (selection.some((s) => s.kind === 'brCircle')) doc.brCircle = null;
}

// ---- clipboard text format (works across maps, tabs and browsers)
const CLIP_TAG = 'evio-map-editor/clipboard@1';
// Imported pieces only make sense in a map opened from the same .evmap (they point at its meshes), so
// the clipboard records which one; pasting elsewhere drops them.
export function toClipboardText(groups, baseKey = null) { return JSON.stringify({ format: CLIP_TAG, base: baseKey, groups }); }
export function fromClipboardText(text, baseKey = null) {
    try {
        const data = JSON.parse(text);
        if (data && data.format === CLIP_TAG && data.groups && typeof data.groups === 'object') {
            const groups = {};
            for (const list of LIST_KINDS) if (Array.isArray(data.groups[list])) groups[list] = data.groups[list];
            if (groups.models && (!baseKey || data.base !== baseKey)) delete groups.models;
            return Object.keys(groups).length ? groups : null;
        }
    } catch { /* not ours */ }
    return null;
}

// ---- 3x3 matrix helpers (row-major, matching geometry.rotationMatrix)
export function mul3(a, b) {
    const o = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    return o;
}

// Inverse of rotationMatrix: Euler XYZ in degrees (THREE.Euler.setFromRotationMatrix, order 'XYZ').
export function eulerXYZFromMatrix(m) {
    const m11 = m[0], m12 = m[1], m13 = m[2], m22 = m[4], m23 = m[5], m32 = m[7], m33 = m[8];
    const y = Math.asin(Math.max(-1, Math.min(1, m13)));
    let x, z;
    if (Math.abs(m13) < 0.9999999) { x = Math.atan2(-m23, m33); z = Math.atan2(-m12, m11); }
    else { x = Math.atan2(m32, m22); z = 0; }
    const d = (v) => { const r = r3(v * 180 / Math.PI); return Object.is(r, -0) ? 0 : r; };
    return { x: d(x), y: d(y), z: d(z) };
}
