// Walk-test physics on a purpose-built map.
//   node tests/test_walk.js
import { newDocument, newId, COLLISION } from '../src/model/document.js';
import { buildWalkWorld, newPlayer, stepPlayer, capsuleContacts, PLAYER } from '../src/model/walk.js';

let failures = 0, checks = 0;
const check = (ok, msg) => { checks++; if (!ok) { failures++; console.log('FAIL', msg); } };
const f2 = (v) => v.toFixed(2);

const doc = newDocument('walk test');   // 60 x 60 floor, top at y = 0
const blk = (shape, position, size, extra = {}) => doc.blocks.push({ id: newId('blk'), shape, position, rotation: { x: 0, y: 0, z: 0 }, size, materialId: 'mat_concrete', collision: COLLISION.SOLID, shadows: true, ...extra });
blk('box', { x: 0, y: 2, z: -16 }, { x: 0.5, y: 4, z: 28 });             // wall at x = 0 ...
blk('box', { x: 0, y: 2, z: 16 }, { x: 0.5, y: 4, z: 28 });              // ... with a doorway at |z| < 2
blk('box', { x: 18, y: 1, z: 18 }, { x: 10, y: 2, z: 10 });              // platform, top y = 2
blk('ramp', { x: 18, y: 1, z: 9 }, { x: 4, y: 2, z: 8 });                // ramp up to it, rising to +z
blk('box', { x: -18, y: 1.5, z: 18 }, { x: 8, y: 3, z: 8 });             // platform, top y = 3
blk('stairs', { x: -18, y: 1.5, z: 11 }, { x: 3, y: 3, z: 6 }, { steps: 6 }); // 0.5 m steps up to it
blk('box', { x: -18, y: 1.45, z: -18 }, { x: 8, y: 0.5, z: 8 });         // low ceiling, bottom y = 1.2
blk('box', { x: 10, y: 2, z: -6 }, { x: 0.5, y: 4, z: 8 }, { collision: COLLISION.INVISIBLE });
blk('box', { x: -8, y: 2, z: -6 }, { x: 0.5, y: 4, z: 8 }, { collision: COLLISION.VISUAL });
blk('box', { x: 24, y: 2.5, z: -20 }, { x: 4, y: 5, z: 4 });             // 5 m block: needs a double jump
blk('box', { x: -6, y: 0.4, z: -24 }, { x: 4, y: 0.8, z: 4 });           // a 0.8 m kerb: the step-up limit
blk('box', { x: 6, y: 0.5, z: -24 }, { x: 4, y: 1, z: 4 });              // a 1 m box: too tall to step
doc.teleporters = [
    { id: 'tA', position: { x: -20, y: 0, z: 0 }, yaw: 0, radius: 1.5, destinations: ['tB'] },
    { id: 'tB', position: { x: 20, y: 2.05, z: 20 }, yaw: 90, radius: 1.5, destinations: [] },
];
const world = buildWalkWorld(doc);

// Yaw that faces a direction (editor/camera convention: 0 faces -z).
const YAW = { '+x': -90, '-x': 90, '+z': 180, '-z': 0 };
function run(p, ticks, input = {}) {
    const events = [];
    for (let i = 0; i < ticks; i++) {
        const ev = stepPlayer(world, p, { ...input, jump: typeof input.jump === 'function' ? input.jump(i, p) : !!input.jump && i === 0 });
        if (Object.keys(ev).length) events.push({ i, ...ev });
    }
    return events;
}
const settle = (x, y, z, yaw = 0) => { const p = newPlayer({ x, y, z }, yaw); run(p, 40); return p; };
// Hold the keys until cond(p) holds (or max ticks); returns the events seen.
function until(p, input, cond, max = 200) {
    const events = [];
    for (let i = 0; i < max && !cond(p); i++) {
        const ev = stepPlayer(world, p, { ...input, jump: typeof input.jump === 'function' ? input.jump(i, p) : false });
        if (Object.keys(ev).length) events.push({ i, ...ev });
    }
    return events;
}

// Falling and standing.
{
    const p = newPlayer({ x: -10, y: 6, z: 4 });
    const ev = run(p, 60);
    check(p.grounded && Math.abs(p.pos.y) < 0.01, `falls and stands on the floor (y ${f2(p.pos.y)})`);
    check(ev.some((e) => e.landed), 'reports landing');
    check(!capsuleContacts(world, { ...p.pos, y: p.pos.y + 0.01 }).length, 'stands clear of the floor, not inside it');
}
// Speeds (the game's: 0.45 u/tick walking = 9 u/s, sprint up to 0.7 = 14 u/s).
{
    const p = settle(-26, 0, -26, YAW['+z']);
    run(p, 20, { forward: true });
    const walk = Math.hypot(p.vel.x, p.vel.z);
    check(Math.abs(walk - 0.45) < 1e-6, `walks at the game's 0.45 u/tick (${f2(walk * 20)} u/s)`);
    run(p, 40, { forward: true, sprint: true });
    const sprint = Math.hypot(p.vel.x, p.vel.z);
    check(Math.abs(sprint - 0.7) < 1e-6, `sprints up to 0.7 u/tick (${f2(sprint * 20)} u/s)`);
    const q = settle(-25, 0, 6, YAW['+x']);
    let t = 0;
    while (Math.hypot(q.vel.x, q.vel.z) < 0.449 && t < 20) { run(q, 1, { forward: true }); t++; }
    check(t === 4, `accelerates to full walking speed in 4 ticks (${t})`);
    run(q, 10);
    check(Math.hypot(q.vel.x, q.vel.z) < 1e-9, 'stops when the keys are released');
}
// Jumps: the game's jump power, gravity and double jump.
{
    const p = settle(-25, 0, 6);
    let peak = 0;
    run(p, 30, { jump: (i) => i === 0 });
    const q = settle(-25, 0, 6);
    for (let i = 0; i < 30; i++) { stepPlayer(world, q, { jump: i === 0 }); peak = Math.max(peak, q.pos.y); }
    const expected = (() => { let v = PLAYER.JUMP_POWER, y = 0, m = 0; for (let i = 0; i < 40; i++) { v -= PLAYER.GRAVITY; y += v; m = Math.max(m, y); } return m; })();
    check(Math.abs(peak - expected) < 0.02, `jump peaks at ${f2(peak)} (game maths: ${f2(expected)})`);
    const r = settle(-25, 0, 6);
    let peak2 = 0;
    for (let i = 0; i < 60; i++) { stepPlayer(world, r, { jump: i === 0 || i === 11 }); peak2 = Math.max(peak2, r.pos.y); }
    check(peak2 > peak * 1.8, `the double jump goes higher (${f2(peak2)})`);
    const s = settle(-25, 0, 6);
    let peak3 = 0;
    for (let i = 0; i < 60; i++) { stepPlayer(world, s, { jump: i === 0 || i === 11 || i === 22 }); peak3 = Math.max(peak3, s.pos.y); }
    check(Math.abs(peak3 - peak2) < 1e-6, 'no third jump');
}
// Walls, doorways, invisible walls, decoration.
{
    const p = settle(-6, 0, 10, YAW['+x']);
    run(p, 40, { forward: true });
    check(p.pos.x < -0.25 - PLAYER.RADIUS + 0.01 && p.pos.x > -1.3, `the wall stops the player (x ${f2(p.pos.x)})`);
    const q = settle(-6, 0, 0, YAW['+x']);
    run(q, 40, { forward: true });
    check(q.pos.x > 5, `walks through the doorway (x ${f2(q.pos.x)})`);
    const r = settle(6, 0, -6, YAW['+x']);
    run(r, 30, { forward: true });
    check(r.pos.x < 10 - 0.25 - PLAYER.RADIUS + 0.01, `the invisible wall blocks (x ${f2(r.pos.x)})`);
    const s = settle(-12, 0, -6, YAW['+x']);
    run(s, 30, { forward: true });
    check(s.pos.x > -4, `decoration does not block (x ${f2(s.pos.x)})`);
}
// Climbing: ramp, stairs, step-up limit, platforms by jumping.
{
    const p = settle(18, 0, 1, YAW['+z']);
    until(p, { forward: true }, (p) => p.pos.z > 16);
    check(p.grounded && Math.abs(p.pos.y - 2) < 0.05 && p.pos.z > 13, `walks up the ramp onto the platform (y ${f2(p.pos.y)}, z ${f2(p.pos.z)})`);
    const q = settle(-18, 0, 4, YAW['+z']);
    until(q, { forward: true }, (p) => p.pos.z > 17, 60);
    check(q.grounded && Math.abs(q.pos.y - 3) < 0.05 && q.pos.z > 14, `climbs the stairs onto the platform (y ${f2(q.pos.y)}, z ${f2(q.pos.z)})`);
    const r = settle(-6, 0, -30 + 1.5, YAW['+z']);
    until(r, { forward: true }, (p) => p.pos.z > -24, 30);
    check(Math.abs(r.pos.y - 0.8) < 0.05, `steps up a 0.8 m kerb without jumping (y ${f2(r.pos.y)})`);
    const s = settle(6, 0, -30 + 1.5, YAW['+z']);
    run(s, 30, { forward: true });
    check(s.pos.y < 0.05 && s.pos.z < -26 - PLAYER.RADIUS + 0.05, `a 1 m box is too tall to step onto (y ${f2(s.pos.y)}, z ${f2(s.pos.z)})`);
    const t = settle(11, 0, 18, YAW['+x']);
    run(t, 30, { forward: true });
    check(t.pos.y < 0.05, 'cannot walk up the 2 m side of the platform');
    until(t, { forward: true, jump: (i) => i === 0 }, (p) => p.grounded && p.pos.x > 15, 40);
    check(Math.abs(t.pos.y - 2) < 0.05, `jumps onto it (y ${f2(t.pos.y)})`);
    const u = settle(24, 0, -14, YAW['-z']);
    run(u, 40, { forward: true, jump: (i) => i === 0 });
    check(u.pos.y < 0.05, `one jump does not reach the top of a 5 m block (y ${f2(u.pos.y)})`);
    const v = settle(24, 0, -14, YAW['-z']);
    until(v, { forward: true, jump: (i) => i === 0 || i === 9 }, (p) => p.grounded && p.pos.z < -20, 60);
    check(Math.abs(v.pos.y - 5) < 0.05, `a double jump does (y ${f2(v.pos.y)})`);
}
// Low ceilings.
{
    const p = settle(-28, 0, -18, YAW['+x']);
    run(p, 40, { forward: true });
    check(p.pos.x < -22 - PLAYER.RADIUS + 0.05 && p.pos.y < 0.05, `cannot walk under a 1.2 m ceiling (x ${f2(p.pos.x)})`);
}
// Teleporters and the kill zone.
{
    const p = settle(-25, 0, 0, YAW['+x']);
    const ev = until(p, { forward: true }, (p) => p.inTeleporter === 1, 40);
    check(ev.some((e) => e.teleported), 'walking into a teleporter teleports');
    run(p, 30);
    check(Math.abs(p.pos.x - 20) < 3 && Math.abs(p.pos.z - 20) < 3 && Math.abs(p.pos.y - 2) < 0.05, `arrives at its destination, on the platform (${f2(p.pos.x)}, ${f2(p.pos.y)}, ${f2(p.pos.z)})`);
    check(p.yaw === (90 + (YAW['+x'] - 0) + 180 + 360) % 360, `facing re-based by the pair's rotation, as in the game (yaw ${p.yaw})`);
    const q = settle(26, 0, 0, YAW['+x']);
    const ev2 = run(q, 200, { forward: true });
    check(ev2.some((e) => e.died), 'walking off the map edge reaches the kill zone');
}

// Speed: one tick must be cheap enough to run many per frame.
{
    const p = settle(-10, 0, 0, YAW['+x']);
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) stepPlayer(world, p, { forward: true, sprint: true, yaw: (i * 3) % 360, jump: i % 25 === 0 });
    const ms = (performance.now() - t0) / 2000;
    check(ms < 1, `a tick takes ${ms.toFixed(3)} ms`);
}

console.log(failures ? `${failures}/${checks} FAILED` : `all ${checks} checks passed`);
process.exit(failures ? 1 : 0);
