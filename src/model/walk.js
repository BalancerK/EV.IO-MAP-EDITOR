// Walk-test physics: a first-person player that moves like ev.io's. Pure JavaScript (no three.js),
// so it runs in the editor and in Node tests.
//
// Movement is a port of the game client's movement step (1-7-1, the function the custom server
// extracts as physics g()): the same per-tick acceleration, speed caps, sprint ramp, air control,
// gravity, fall-speed cap and jump/double-jump rules, at the game's fixed 20 ticks a second. Units
// are the game's (map units per tick). The default loadout's jump power and jump count are used.
//
// Collision is the editor's own: a vertical capsule (the game's player radius and height) pushed
// out of the map's collision triangles, with the game's step-up height. The game's capsule sweep is
// a different algorithm, so contact against edges and corners can differ slightly; heights, gaps,
// speeds and jumps are the game's numbers.
import { buildBlockTriangles } from './geometry.js';
import { COLLISION } from './document.js';

export const PLAYER = {
    TICK_RATE: 20,
    RADIUS: 0.897,          // PLAYER_RADIUS
    HEIGHT: 2.86,           // PLAYER_HEIGHT
    EYE: 1.8,               // PLAYER_HEIGHT_CAMERA
    EYE_CROUCH: 1.0,        // PLAYER_HEIGHT_DUCKED_CAMERA
    STEP_UP: 0.8,           // STEP_UP_MAX
    ACCEL: 0.14,            // ACCELERATION
    MAX_SPEED: 0.45,        // MAX_MOVE_SPEED (default loadout)
    MAX_SPRINT: 0.7,        // MAX_SPRINT_SPEED
    SPRINT_L2: 0.52, SPRINT_L3: 0.59,                     // sprint ramp thresholds
    SPRINT_ACC: [1.09, 1.033, 1.0065],                    // sprint ramp per level
    AIR_ACCEL_MUL: 0.2,     // AIR_ACCEL_MULTIPLIER
    MAX_AIR_SPEED: 0.2,     // MAX_AIR_SPEED
    CROUCH_MOD: 0.5,        // CROUCH_MOVE_SPEED_MOD
    GRAVITY: 0.07,          // per tick² (28 u/s²)
    MAX_FALL: 1.6,          // MAX_FALL_SPEED
    JUMP_POWER: 0.77,       // default loadout jump power
    MAX_JUMPS: 2,           // default loadout: a jump and one double jump
    KILL_Y: -30,
    WALKABLE_NY: Math.cos(46 * Math.PI / 180),            // floors up to ~45 degrees
};
const CELL = 4;

// ------------------------------------------------------------------ the collision world
export function buildWalkWorld(doc) {
    const tris = [];
    for (const b of doc.blocks) {
        if (b.collision === COLLISION.VISUAL) continue;
        const { positions } = buildBlockTriangles(b);
        for (let i = 0; i < positions.length; i += 9) {
            const a = [positions[i], positions[i + 1], positions[i + 2]];
            const bb = [positions[i + 3], positions[i + 4], positions[i + 5]];
            const c = [positions[i + 6], positions[i + 7], positions[i + 8]];
            const u = sub(bb, a), v = sub(c, a);
            const n = cross(u, v), len = Math.hypot(n[0], n[1], n[2]);
            if (len < 1e-10) continue;
            tris.push({
                a, b: bb, c, n: [n[0] / len, n[1] / len, n[2] / len],
                min: [Math.min(a[0], bb[0], c[0]), Math.min(a[1], bb[1], c[1]), Math.min(a[2], bb[2], c[2])],
                max: [Math.max(a[0], bb[0], c[0]), Math.max(a[1], bb[1], c[1]), Math.max(a[2], bb[2], c[2])],
            });
        }
    }
    const bins = new Map();
    tris.forEach((t, idx) => {
        for (let i = Math.floor(t.min[0] / CELL); i <= Math.floor(t.max[0] / CELL); i++)
            for (let j = Math.floor(t.min[2] / CELL); j <= Math.floor(t.max[2] / CELL); j++) {
                const k = i + ',' + j;
                let list = bins.get(k);
                if (!list) bins.set(k, list = []);
                list.push(idx);
            }
    });
    const teleporters = (doc.teleporters || []).map((t) => ({ ...t, radius: t.radius || 1.5 }));
    const spawns = (doc.playerSpawns || []).filter((s) => s.position);
    return { tris, bins, teleporters, spawns, stamp: 0, seen: new Uint32Array(tris.length) };
}

// Triangles whose bounds overlap the box.
function near(world, min, max) {
    const out = [];
    const stamp = ++world.stamp;
    for (let i = Math.floor(min[0] / CELL); i <= Math.floor(max[0] / CELL); i++)
        for (let j = Math.floor(min[2] / CELL); j <= Math.floor(max[2] / CELL); j++) {
            const list = world.bins.get(i + ',' + j);
            if (!list) continue;
            for (const idx of list) {
                if (world.seen[idx] === stamp) continue;
                world.seen[idx] = stamp;
                const t = world.tris[idx];
                if (t.max[0] < min[0] || t.min[0] > max[0] || t.max[1] < min[1] || t.min[1] > max[1] || t.max[2] < min[2] || t.min[2] > max[2]) continue;
                out.push(t);
            }
        }
    return out;
}

/** Every triangle the standing capsule with its feet at `p` overlaps: [{ n, depth }]. */
export function capsuleContacts(world, p, height = PLAYER.HEIGHT) {
    const R = PLAYER.RADIUS;
    const y0 = p.y + R, y1 = p.y + height - R;
    const cands = near(world, [p.x - R, p.y, p.z - R], [p.x + R, p.y + height, p.z + R]);
    const out = [];
    for (const t of cands) {
        // Distance from a point on the capsule's axis to the triangle is convex along the axis,
        // so a ternary search finds the closest pair.
        let lo = y0, hi = y1;
        for (let k = 0; k < 22 && hi - lo > 1e-4; k++) {
            const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
            if (dist2(t, p.x, m1, p.z) < dist2(t, p.x, m2, p.z)) hi = m2; else lo = m1;
        }
        const y = (lo + hi) / 2;
        const q = closestOnTriangle([p.x, y, p.z], t.a, t.b, t.c);
        const dx = p.x - q[0], dy = y - q[1], dz = p.z - q[2];
        const d = Math.hypot(dx, dy, dz);
        if (d >= R - 1e-5) continue;
        let n;
        if (d > 1e-6) n = [dx / d, dy / d, dz / d];
        else n = t.n;   // the axis passes through the triangle: push out along its face
        out.push({ n, depth: R - d, y: q[1] });   // y: height of the touching point
    }
    return out;
}
function dist2(t, x, y, z) {
    const q = closestOnTriangle([x, y, z], t.a, t.b, t.c);
    return (x - q[0]) ** 2 + (y - q[1]) ** 2 + (z - q[2]) ** 2;
}

// Push the capsule out of the world. Floors push straight up (so standing on a ramp does not slide),
// walls and steep slopes push along their normal, ceilings push down.
// `step` (while settling onto a step): an edge no higher than step.maxY also counts as floor.
function resolve(world, pos, vel, height, step = null) {
    const out = { grounded: false, wall: false, ceiling: false };
    for (let iter = 0; iter < 8; iter++) {
        const contacts = capsuleContacts(world, pos, height);
        if (!contacts.length) break;
        let c = contacts[0];
        for (const x of contacts) if (x.depth > c.depth) c = x;
        const [nx, ny, nz] = c.n;
        if (ny >= PLAYER.WALKABLE_NY || (step && ny > 0.2 && c.y <= step.maxY)) {
            pos.y += Math.min(c.depth / ny, PLAYER.RADIUS) + 1e-4;
            if (vel.y < 0) vel.y = 0;
            out.grounded = true;
        } else {
            pos.x += nx * (c.depth + 1e-4); pos.y += ny * (c.depth + 1e-4); pos.z += nz * (c.depth + 1e-4);
            const vn = vel.x * nx + vel.y * ny + vel.z * nz;
            if (vn < 0) { vel.x -= nx * vn; vel.y -= ny * vn; vel.z -= nz * vn; }
            if (ny < -0.3) out.ceiling = true; else out.wall = true;
        }
    }
    return out;
}

// Move by `d`, then push out. Returns the contact summary.
function attempt(world, pos, vel, d, height, step) {
    pos.x += d.x; pos.y += d.y; pos.z += d.z;
    return resolve(world, pos, vel, height, step);
}

// One sub-step of movement, with the game's step-up: when walking into something no taller than
// STEP_UP, lift over it.
function moveStep(world, s, d) {
    const h = PLAYER.HEIGHT;
    const p0 = { ...s.pos };
    const pa = { ...p0 }, va = { ...s.vel };
    const ra = attempt(world, pa, va, d, h);
    const horiz = Math.hypot(d.x, d.z);
    if (s.grounded && ra.wall && horiz > 1e-5) {
        const pb = { x: p0.x, y: p0.y + PLAYER.STEP_UP, z: p0.z }, vb = { ...s.vel };
        if (!capsuleContacts(world, pb, h).length) {
            attempt(world, pb, vb, { x: d.x, y: 0, z: d.z }, h);
            // Settle back down in small steps, so the body lands on top of the step instead of
            // sinking into it and being pushed back out of its side. The rounded bottom may first
            // meet the step's edge: that counts as standing on it.
            let rb = { grounded: false };
            for (let k = 0, down = PLAYER.STEP_UP + 0.05; k < 9 && !rb.grounded; k++) rb = attempt(world, pb, vb, { x: 0, y: -down / 9, z: 0 }, h, { maxY: p0.y + PLAYER.STEP_UP + 1e-3 });
            const progA = (pa.x - p0.x) * d.x + (pa.z - p0.z) * d.z;
            const progB = (pb.x - p0.x) * d.x + (pb.z - p0.z) * d.z;
            if (rb.grounded && pb.y - p0.y <= PLAYER.STEP_UP + 1e-3 && progB > progA + 1e-4) {
                s.pos = pb; s.vel = { x: vb.x, y: Math.max(0, va.y), z: vb.z };
                return { grounded: true, wall: false, ceiling: false };
            }
        }
    }
    s.pos = pa; s.vel = va;
    return ra;
}

// ------------------------------------------------------------------ the player
export function newPlayer(position, yaw = 0) {
    return { pos: { x: position.x, y: position.y, z: position.z }, vel: { x: 0, y: 0, z: 0 }, yaw, grounded: false, jumps: 0, sprinting: false, crouching: false, inTeleporter: -1, ticks: 0 };
}

/**
 * Advance one game tick. `input`: { forward, back, left, right, sprint, crouch, jump (pressed this
 * tick), yaw (degrees, editor/camera convention: 0 faces -z) }. Returns events for the HUD:
 * { landed, jumped, teleported, died }.
 */
export function stepPlayer(world, s, input) {
    const P = PLAYER, ev = {};
    if (input.yaw !== undefined) s.yaw = input.yaw;
    const yr = s.yaw * Math.PI / 180;
    const fwd = { x: -Math.sin(yr), z: -Math.cos(yr) }, right = { x: Math.cos(yr), z: -Math.sin(yr) };
    let wx = 0, wz = 0;
    if (input.forward) { wx += fwd.x; wz += fwd.z; }
    if (input.back) { wx -= fwd.x; wz -= fwd.z; }
    if (input.right) { wx += right.x; wz += right.z; }
    if (input.left) { wx -= right.x; wz -= right.z; }
    if (!s.grounded && wx * wx + wz * wz < 0.001) { wx = s.vel.x; wz = s.vel.z; }
    let wl = Math.hypot(wx, wz);
    if (wl > 0) { wx = wx / wl * 5; wz = wz / wl * 5; }
    wl = Math.hypot(wx, wz);

    let j = P.MAX_SPEED;
    s.crouching = !!input.crouch && s.grounded;
    const speed = Math.hypot(s.vel.x, s.vel.z);
    s.sprinting = !!input.sprint && !!input.forward && !(input.left && input.right) && !s.crouching && wl > 1e-4;
    if (s.crouching) j *= P.CROUCH_MOD;
    if (s.sprinting) {
        let L = speed > P.SPRINT_L3 ? P.SPRINT_ACC[2] : speed > P.SPRINT_L2 ? P.SPRINT_ACC[1] : P.SPRINT_ACC[0];
        if (input.left || input.right) L = (L - 1) * (input.forward ? 0.66 : 0.33) + 1;
        if (input.back) L = 1;
        j = Math.min(Math.max(j, speed) * L, P.MAX_SPRINT);
    }

    let vy = s.vel.y;
    let sx = wx - s.vel.x, sz = wz - s.vel.z;
    const clamp = (x, z, max) => { const l = Math.hypot(x, z); return l > max ? [x / l * max, z / l * max] : [x, z]; };
    if (s.grounded) {
        [sx, sz] = clamp(sx, sz, P.ACCEL);
        [s.vel.x, s.vel.z] = clamp(s.vel.x + sx, s.vel.z + sz, Math.max(j, 0.85 * speed));
        vy = 0;
    } else {
        [sx, sz] = clamp(sx, sz, P.ACCEL * P.AIR_ACCEL_MUL);
        [s.vel.x, s.vel.z] = clamp(s.vel.x + sx, s.vel.z + sz, Math.max(P.MAX_AIR_SPEED, speed));
    }
    s.vel.y = vy;

    if (input.jump) {
        if (s.grounded) { s.vel.y = P.JUMP_POWER; s.grounded = false; s.jumps = 1; ev.jumped = true; }
        else if (s.jumps < P.MAX_JUMPS) { s.vel.y = P.JUMP_POWER; s.jumps++; ev.jumped = true; }
    }
    s.vel.y = Math.max(s.vel.y - P.GRAVITY, -P.MAX_FALL);

    // Move in sub-steps no longer than half the radius, so a fast fall cannot pass through a floor.
    const wasGrounded = s.grounded;
    const len = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
    const n = Math.max(1, Math.min(8, Math.ceil(len / (P.RADIUS * 0.5))));
    let grounded = false;
    for (let i = 0; i < n; i++) {
        const r = moveStep(world, s, { x: s.vel.x / n, y: s.vel.y / n, z: s.vel.z / n });
        if (r.grounded) { grounded = true; s.grounded = true; }
    }
    s.grounded = grounded;
    if (grounded) s.jumps = 0;
    if (grounded && !wasGrounded) ev.landed = true;
    s.ticks++;

    // Teleporters fire on entering one that has destinations (probe: the body's centre, radius + 1).
    const inside = teleporterAt(world, s.pos);
    if (inside !== s.inTeleporter) {
        s.inTeleporter = inside;
        if (inside >= 0) {
            const from = world.teleporters[inside];
            const dests = from.destinations.map((id) => world.teleporters.findIndex((t) => t.id === id)).filter((i) => i >= 0);
            if (dests.length) {
                const di = dests[Math.floor(Math.random() * dests.length)];
                const to = world.teleporters[di];
                const delta = (to.yaw || 0) - (from.yaw || 0) + 180;
                s.pos = { ...to.position };
                s.yaw = (((to.yaw || 0) + (s.yaw - (from.yaw || 0)) + 180) % 360 + 360) % 360;
                const a = delta * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
                const x = s.vel.x, z = s.vel.z;
                s.vel.x = x * c + z * sn; s.vel.z = -x * sn + z * c;
                s.inTeleporter = di;
                s.grounded = false;
                ev.teleported = true;
            }
        }
    }
    if (s.pos.y < P.KILL_Y) ev.died = true;
    return ev;
}

function teleporterAt(world, pos) {
    for (let i = 0; i < world.teleporters.length; i++) {
        const t = world.teleporters[i];
        if (!t.destinations || !t.destinations.length) continue;
        const dx = pos.x - t.position.x, dy = pos.y + 1 - t.position.y, dz = pos.z - t.position.z;
        const r = t.radius + 1;
        if (dx * dx + dy * dy + dz * dz <= r * r) return i;
    }
    return -1;
}

// ------------------------------------------------------------------ vector helpers
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

// Closest point on triangle abc to p (Ericson, Real-Time Collision Detection 5.1.5).
function closestOnTriangle(p, a, b, c) {
    const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
    const d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return a;
    const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return b;
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]; }
    const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return c;
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]; }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w];
    }
    const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
    return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}
