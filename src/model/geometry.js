// Block shapes as flat-shaded triangle soups, in GAME coordinates (right-handed, y up — the same
// space the ev.io client renders in, and the space the editor works in). Each shape is built
// around a unit-free local frame: x across, y up, z along; size scales it, then the block's
// rotation (Euler XYZ, degrees — THREE.Euler's default order) and position place it.
//
// A block's `position` is the centre of its bounding box.

export const SHAPES = ['box', 'ramp', 'stairs', 'cylinder', 'wedge-corner'];

// Each face: an array of corner points (convex polygon, counter-clockwise seen from outside).
function boxFaces(sx, sy, sz) {
    const x = sx / 2, y = sy / 2, z = sz / 2;
    const p = (a, b, c) => [a * x, b * y, c * z];
    return [
        [p(-1, -1, 1), p(1, -1, 1), p(1, 1, 1), p(-1, 1, 1)],     // +z
        [p(1, -1, -1), p(-1, -1, -1), p(-1, 1, -1), p(1, 1, -1)], // -z
        [p(1, -1, 1), p(1, -1, -1), p(1, 1, -1), p(1, 1, 1)],     // +x
        [p(-1, -1, -1), p(-1, -1, 1), p(-1, 1, 1), p(-1, 1, -1)], // -x
        [p(-1, 1, 1), p(1, 1, 1), p(1, 1, -1), p(-1, 1, -1)],     // +y
        [p(-1, -1, -1), p(1, -1, -1), p(1, -1, 1), p(-1, -1, 1)], // -y
    ];
}

// Ramp: full height at +z, zero height at -z (walk up it towards +z).
function rampFaces(sx, sy, sz) {
    const x = sx / 2, y = sy / 2, z = sz / 2;
    return [
        [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]],          // back wall (+z)
        [[-x, -y, -z], [-x, y, z], [x, y, z], [x, -y, -z]],        // slope
        [[x, -y, z], [x, -y, -z], [x, y, z]],                      // +x side
        [[-x, -y, -z], [-x, -y, z], [-x, y, z]],                   // -x side
        [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]],      // bottom
    ];
}

// Corner wedge: a ramp that rises towards +x and +z (for ramp corners).
function cornerFaces(sx, sy, sz) {
    const x = sx / 2, y = sy / 2, z = sz / 2;
    return [
        [[-x, -y, z], [x, -y, z], [x, y, z]],                      // +z wall (triangle)
        [[x, -y, z], [x, -y, -z], [x, y, z]],                      // +x wall (triangle)
        [[-x, -y, -z], [-x, -y, z], [x, y, z]],                    // slope, -x half
        [[-x, -y, -z], [x, y, z], [x, -y, -z]],                    // slope, -z half
        [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]],      // bottom
    ];
}

// Stairs: `steps` treads rising towards +z, each a box from the floor up.
function stairFaces(sx, sy, sz, steps) {
    const n = Math.max(1, Math.min(64, Math.round(steps || 6)));
    const faces = [];
    for (let i = 0; i < n; i++) {
        const h = (sy * (i + 1)) / n, d = sz / n;
        const cz = -sz / 2 + d * i + d / 2;
        for (const f of boxFaces(sx, h, d)) {
            faces.push(f.map(([a, b, c]) => [a, b - sy / 2 + h / 2, c + cz]));
        }
    }
    return faces;
}

function cylinderFaces(sx, sy, sz, segments) {
    const n = Math.max(6, Math.min(48, Math.round(segments || 16)));
    const rx = sx / 2, rz = sz / 2, y = sy / 2;
    const ring = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        ring.push([Math.cos(a) * rx, Math.sin(a) * rz]);
    }
    const faces = [];
    for (let i = 0; i < n; i++) {
        const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % n];
        faces.push([[ax, -y, az], [ax, y, az], [bx, y, bz], [bx, -y, bz]]);
    }
    faces.push(ring.map(([a, b]) => [a, y, b]).reverse());   // top
    faces.push(ring.map(([a, b]) => [a, -y, b]));            // bottom
    return faces;
}

export function shapeFaces(block) {
    const { x: sx, y: sy, z: sz } = block.size;
    switch (block.shape) {
        case 'ramp': return rampFaces(sx, sy, sz);
        case 'wedge-corner': return cornerFaces(sx, sy, sz);
        case 'stairs': return stairFaces(sx, sy, sz, block.steps);
        case 'cylinder': return cylinderFaces(sx, sy, sz, block.segments);
        default: return boxFaces(sx, sy, sz);
    }
}

// Rotation matrix for THREE.Euler order 'XYZ' (R = Rx * Ry * Rz), degrees in.
export function rotationMatrix(rot) {
    const d = Math.PI / 180;
    const a = (rot?.x || 0) * d, b = (rot?.y || 0) * d, c = (rot?.z || 0) * d;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
    // Row-major 3x3, identical to THREE.Matrix4.makeRotationFromEuler for 'XYZ'.
    return [
        cb * cc, -cb * sc, sb,
        ca * sc + sa * sb * cc, ca * cc - sa * sb * sc, -sa * cb,
        sa * sc - ca * sb * cc, sa * cc + ca * sb * sc, ca * cb,
    ];
}

const apply = (m, [x, y, z]) => [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];

// Triangulated, world-placed block: { positions: number[], normals: number[] } (3 per vertex),
// triangles counter-clockwise seen from outside, flat normals.
export function buildBlockTriangles(block) {
    const m = rotationMatrix(block.rotation);
    const t = block.position;
    const positions = [], normals = [];
    for (const face of shapeFaces(block)) {
        const pts = face.map((p) => { const r = apply(m, p); return [r[0] + t.x, r[1] + t.y, r[2] + t.z]; });
        // Face normal from the first non-degenerate corner triple (Newell's method is overkill here).
        const nrm = newell(pts);
        if (!nrm) continue;
        for (let i = 1; i + 1 < pts.length; i++) {
            for (const p of [pts[0], pts[i], pts[i + 1]]) { positions.push(p[0], p[1], p[2]); normals.push(nrm[0], nrm[1], nrm[2]); }
        }
    }
    return { positions, normals };
}

function newell(pts) {
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < pts.length; i++) {
        const [x1, y1, z1] = pts[i], [x2, y2, z2] = pts[(i + 1) % pts.length];
        nx += (y1 - y2) * (z1 + z2); ny += (z1 - z2) * (x1 + x2); nz += (x1 - x2) * (y1 + y2);
    }
    const len = Math.hypot(nx, ny, nz);
    return len > 1e-12 ? [nx / len, ny / len, nz / len] : null;
}

// Axis-aligned bounds of a list of blocks (for shadow-camera sizing and validation).
export function blocksBounds(blocks) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const b of blocks) {
        const { positions } = buildBlockTriangles(b);
        for (let i = 0; i < positions.length; i++) {
            const a = i % 3;
            if (positions[i] < min[a]) min[a] = positions[i];
            if (positions[i] > max[a]) max[a] = positions[i];
        }
    }
    return { min, max };
}
