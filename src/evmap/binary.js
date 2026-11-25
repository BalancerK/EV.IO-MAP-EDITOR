// Little-endian binary reader/writer matching the ev.io client's BinaryBufferReader
// (bundle 1-7-1, `chomp*` methods). Every multi-byte value is little-endian; strings are a u8
// length followed by one byte per character (the client reads them with String.fromCharCode).

export class BinaryReader {
    constructor(arrayBuffer) {
        this.buffer = arrayBuffer;
        this.view = new DataView(arrayBuffer);
        this.bytes = new Uint8Array(arrayBuffer);
        this.pos = 0;
    }
    u8() { return this.bytes[this.pos++]; }
    i16() { const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
    u16() { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
    u32() { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
    f32() { const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
    vec3() { return { x: this.f32(), y: this.f32(), z: this.f32() }; }
    vec4() { return { x: this.f32(), y: this.f32(), z: this.f32(), w: this.f32() }; }
    quat() { return this.vec4(); }
    rgb24() { return { r: this.u8() / 255, g: this.u8() / 255, b: this.u8() / 255 }; }
    rgba32() { const c = this.rgb24(); return { ...c, a: this.u8() / 255 }; }
    string() {
        const n = this.u8();
        let s = '';
        for (let i = 0; i < n; i++) s += String.fromCharCode(this.bytes[this.pos + i]);
        this.pos += n;
        return s;
    }
    bytesN(n) { const out = this.bytes.slice(this.pos, this.pos + n); this.pos += n; return out; }
    u16ArrayN(n) { const a = new Uint16Array(n); for (let i = 0; i < n; i++) a[i] = this.u16(); return a; }
    u16ArrayLen16() { return this.u16ArrayN(this.u16()); }
    list(fn) { const n = this.u16(); const out = []; for (let i = 0; i < n; i++) out.push(fn(this)); return out; }

    // chompEVBoundedVec3Buffer: 0 => empty. NOTE the client does NOT consume the 0 byte, so an empty
    // buffer desyncs everything after it in the client. Writers must never emit one (see writer).
    boundedVec3() {
        if (this.bytes[this.pos] === 0) { this.pos++; return new Float32Array(0); }
        this.pos++;
        const min = [this.f32(), this.f32(), this.f32()];
        const max = [this.f32(), this.f32(), this.f32()];
        const n = this.u16() * 3;
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const axis = i % 3;
            out[i] = (max[axis] - min[axis]) * (this.u16() / 65535) + min[axis];
        }
        return out;
    }
    boundedVec2() {
        if (this.bytes[this.pos] === 0) { this.pos++; return new Float32Array(0); }
        this.pos++;
        const min = [this.f32(), this.f32()];
        const max = [this.f32(), this.f32()];
        const n = this.u16() * 2;
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const axis = i % 2;
            out[i] = (max[axis] - min[axis]) * (this.u16() / 65535) + min[axis];
        }
        return out;
    }
    // chompEVPaletteUvBuffer: u16 count, then 4 bits per vertex (2 bits u, 2 bits v) selecting the
    // centre of a cell in a 4x4 palette texture.
    paletteUv() {
        const n = this.u16();
        const out = new Float32Array(n * 2);
        for (let v = 0; v < n; v++) {
            const byte = this.bytes[this.pos + (v >> 1)];
            const nib = (v & 1) ? (byte >> 4) : (byte & 15);
            out[v * 2] = 0.125 + 0.25 * (nib & 3);
            out[v * 2 + 1] = 0.125 + 0.25 * ((nib & 12) >> 2);
        }
        this.pos += (n + 1) >> 1;
        return out;
    }
}

export class BinaryWriter {
    constructor(initial = 1 << 16) {
        this.bytes = new Uint8Array(initial);
        this.view = new DataView(this.bytes.buffer);
        this.pos = 0;
    }
    ensure(n) {
        if (this.pos + n <= this.bytes.length) return;
        let size = this.bytes.length * 2;
        while (size < this.pos + n) size *= 2;
        const next = new Uint8Array(size);
        next.set(this.bytes.subarray(0, this.pos));
        this.bytes = next;
        this.view = new DataView(next.buffer);
    }
    u8(v) { this.ensure(1); this.bytes[this.pos++] = v & 255; }
    i16(v) { this.ensure(2); this.view.setInt16(this.pos, v, true); this.pos += 2; }
    u16(v) {
        if (!(v >= 0 && v <= 65535)) throw new RangeError(`u16 out of range: ${v}`);
        this.ensure(2); this.view.setUint16(this.pos, v, true); this.pos += 2;
    }
    u32(v) { this.ensure(4); this.view.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
    f32(v) { this.ensure(4); this.view.setFloat32(this.pos, v, true); this.pos += 4; }
    vec3(v) { this.f32(v.x); this.f32(v.y); this.f32(v.z); }
    vec4(v) { this.f32(v.x); this.f32(v.y); this.f32(v.z); this.f32(v.w); }
    quat(q) { this.vec4(q); }
    rgb24(c) { this.u8(clampByte(c.r)); this.u8(clampByte(c.g)); this.u8(clampByte(c.b)); }
    rgba32(c) { this.rgb24(c); this.u8(clampByte(c.a ?? 1)); }
    string(s) {
        if (s.length > 255) throw new RangeError('string longer than 255 characters');
        this.u8(s.length);
        for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i) & 255);
    }
    bytesN(arr) { this.ensure(arr.length); this.bytes.set(arr, this.pos); this.pos += arr.length; }
    u16Array(arr) { for (const v of arr) this.u16(v); }
    u16ArrayLen16(arr) { this.u16(arr.length); this.u16Array(arr); }
    list(items, fn) { this.u16(items.length); for (const it of items) fn(this, it); }

    boundedVec3(arr) {
        if (!arr.length) throw new Error('empty vec3 buffer: the ev.io client cannot read one');
        const n = arr.length / 3;
        if (n > 65535) throw new RangeError('more than 65535 vertices in one mesh');
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < arr.length; i++) {
            const a = i % 3;
            if (arr[i] < min[a]) min[a] = arr[i];
            if (arr[i] > max[a]) max[a] = arr[i];
        }
        this.u8(1);
        min.forEach((v) => this.f32(v));
        max.forEach((v) => this.f32(v));
        this.u16(n);
        for (let i = 0; i < arr.length; i++) {
            const a = i % 3, range = max[a] - min[a];
            this.u16(range > 0 ? Math.round(((arr[i] - min[a]) / range) * 65535) : 0);
        }
    }
    boundedVec2(arr) {
        if (!arr.length) throw new Error('empty vec2 buffer: the ev.io client cannot read one');
        const n = arr.length / 2;
        const min = [Infinity, Infinity], max = [-Infinity, -Infinity];
        for (let i = 0; i < arr.length; i++) {
            const a = i % 2;
            if (arr[i] < min[a]) min[a] = arr[i];
            if (arr[i] > max[a]) max[a] = arr[i];
        }
        this.u8(1);
        min.forEach((v) => this.f32(v));
        max.forEach((v) => this.f32(v));
        this.u16(n);
        for (let i = 0; i < arr.length; i++) {
            const a = i % 2, range = max[a] - min[a];
            this.u16(range > 0 ? Math.round(((arr[i] - min[a]) / range) * 65535) : 0);
        }
    }
    result() { return this.bytes.slice(0, this.pos); }
}

function clampByte(f) { return Math.max(0, Math.min(255, Math.round((f ?? 0) * 255))); }
