// Port of engine-core (SST codec, bloom, crc32, merge) and an LZ4 block codec to Zig,
// exported with the flat ABI in crates/engine-abi.md. See README.md.
const std = @import("std");
const Bytes = std.array_list.Managed(u8);

const MAGIC: u32 = 0x4f4c5354;
const VERSION: u32 = 1;
const FOOTER: usize = 44;
const TAG_PUT: u8 = 1;
const TAG_DEL: u8 = 2;
const BLOCK_TARGET: usize = 4 * 1024;
const STRIDE: usize = 4;

const Err = error{ TooShort, BadMagic, BadVersion, CrcMismatch, Truncated, BadTag, TrailingGarbage, CountMismatch, BadCodec, BadBlock, OutOfMemory, PatternsTruncated };

fn code(e: anyerror) i32 {
    return switch (e) {
        error.TooShort => -1,
        error.BadMagic => -2,
        error.BadVersion => -3,
        error.CrcMismatch => -4,
        error.Truncated => -5,
        error.BadTag => -6,
        error.TrailingGarbage => -7,
        error.CountMismatch => -8,
        error.BadCodec => -9,
        error.BadBlock => -10,
        error.OutOfMemory => -11,
        error.PatternsTruncated => -12,
        else => -99,
    };
}

const Entry = struct { key: []const u8, value: []const u8, seq: u64, put: bool };

// ---- slab ----------------------------------------------------------------
// `init` grows memory once to hold the slab; nothing grows it afterwards. Each operation
// reads its input from the front of the slab and bump-allocates everything else, result
// included, from the bytes after the input. The arena is reset at the start of the next
// operation, so a result lives until then.
var slab: []u8 = &[_]u8{};
var reserved: usize = 0;
var arena_off: usize = 0;
var fba = std.heap.FixedBufferAllocator.init(&[_]u8{});
var peak: usize = 0;
var result: []const u8 = &[_]u8{};

const FBA = std.heap.FixedBufferAllocator;
fn notePeak() void {
    peak = @max(peak, arena_off + fba.end_index);
}
fn bumpAlloc(ctx: *anyopaque, n: usize, a: std.mem.Alignment, ra: usize) ?[*]u8 {
    const p = FBA.alloc(ctx, n, a, ra);
    notePeak();
    return p;
}
fn bumpResize(ctx: *anyopaque, m: []u8, a: std.mem.Alignment, n: usize, ra: usize) bool {
    const ok = FBA.resize(ctx, m, a, n, ra);
    notePeak();
    return ok;
}
fn bumpRemap(ctx: *anyopaque, m: []u8, a: std.mem.Alignment, n: usize, ra: usize) ?[*]u8 {
    return if (bumpResize(ctx, m, a, n, ra)) m.ptr else null;
}
const A: std.mem.Allocator = .{ .ptr = &fba, .vtable = &.{ .alloc = bumpAlloc, .resize = bumpResize, .remap = bumpRemap, .free = FBA.free } };

export fn init(capacity: u32) i32 {
    if (reserved == 0) {
        const pages = (@as(u64, capacity) + 0xffff) >> 16;
        const old = @wasmMemoryGrow(0, @intCast(pages));
        if (old < 0) return code(error.OutOfMemory);
        reserved = @intCast(pages << 16);
        slab = @as([*]u8, @ptrFromInt(@as(usize, @intCast(old)) << 16))[0..capacity];
    } else if (capacity > reserved) {
        return code(error.OutOfMemory);
    } else {
        slab = slab.ptr[0..capacity];
    }
    peak = 0;
    result = &[_]u8{};
    return 0;
}
export fn input_ptr(len: u32) usize {
    return if (slab.len == 0 or len > slab.len) 0 else @intFromPtr(slab.ptr);
}
export fn peak_bytes() u32 {
    return @intCast(peak);
}
export fn result_ptr() usize {
    return @intFromPtr(result.ptr);
}
export fn result_len() u32 {
    return @intCast(result.len);
}

// The arena starts past the furthest input byte, so inputs are never overwritten.
fn begin(input_end: usize) Err!void {
    result = &[_]u8{};
    scratch = &[_]u8{};
    const base = @intFromPtr(slab.ptr);
    const off = if (input_end > base) std.mem.alignForward(usize, input_end - base, 16) else 0;
    if (off > slab.len) return error.OutOfMemory;
    arena_off = off;
    fba = FBA.init(slab[off..]);
    notePeak();
}

// ---- small helpers -------------------------------------------------------
inline fn rd32(b: []const u8, o: usize) u32 {
    return std.mem.readInt(u32, b[o..][0..4], .little);
}
inline fn rd64(b: []const u8, o: usize) u64 {
    return std.mem.readInt(u64, b[o..][0..8], .little);
}
fn put32(out: *Bytes, v: u32) !void {
    var t: [4]u8 = undefined;
    std.mem.writeInt(u32, &t, v, .little);
    try out.appendSlice(&t);
}
fn put16(out: *Bytes, v: u16) !void {
    var t: [2]u8 = undefined;
    std.mem.writeInt(u16, &t, v, .little);
    try out.appendSlice(&t);
}
fn put64(out: *Bytes, v: u64) !void {
    var t: [8]u8 = undefined;
    std.mem.writeInt(u64, &t, v, .little);
    try out.appendSlice(&t);
}

fn varintLen(v0: usize) usize {
    var v = v0;
    var n: usize = 1;
    while (v >= 0x80) {
        v >>= 7;
        n += 1;
    }
    return n;
}
fn putVarint(out: *Bytes, v0: usize) !void {
    var v = v0;
    while (v >= 0x80) {
        try out.append(@as(u8, @truncate(v)) | 0x80);
        v >>= 7;
    }
    try out.append(@truncate(v));
}
fn readVarint(b: []const u8, o: *usize, end: usize) Err!usize {
    var v: u64 = 0;
    var shift: u6 = 0;
    while (shift < 35) : (shift += 7) {
        if (o.* >= end) return error.Truncated;
        const x = b[o.*];
        o.* += 1;
        v |= @as(u64, x & 0x7f) << shift;
        if (x < 0x80) return if (v > std.math.maxInt(u32)) error.BadBlock else @intCast(v);
    }
    return error.BadBlock;
}
fn commonPrefix(a: []const u8, b: []const u8) usize {
    const n = @min(a.len, b.len);
    var i: usize = 0;
    while (i < n and a[i] == b[i]) i += 1;
    return i;
}
fn offsetTableBytes(count: usize) usize {
    return 2 * ((count -| 1) / STRIDE);
}
fn recordOverhead(e: Entry) usize {
    const n = 1 + 8 + varintLen(e.key.len);
    return if (e.put) n + varintLen(e.value.len) + e.value.len else n;
}
fn entrySize(e: Entry) usize {
    return 1 + 8 + 4 + e.key.len + (if (e.put) 4 + e.value.len else 0);
}

// ---- crc32 / bloom ---------------------------------------------------------
fn crc32(b: []const u8) u32 {
    return std.hash.Crc32.hash(b);
}

fn fnv1a(d: []const u8) u32 {
    var h: u32 = 2166136261;
    for (d) |c| {
        h ^= c;
        h *%= 16777619;
    }
    return h;
}
fn mix(h0: u32) u32 {
    var h = h0;
    h ^= h >> 16;
    h *%= 0x7feb352d;
    h ^= h >> 15;
    h *%= 0x846ca68b;
    h ^= h >> 16;
    return h;
}
const Bloom = struct { bits: []u8, hash_count: u32 };
fn createBloom(key_count: usize, bits_per_key: usize) !Bloom {
    const n = @max(key_count, 1);
    const bit_count = @max(n * bits_per_key, 64);
    const hc: u32 = @intFromFloat(@round(@as(f64, @floatFromInt(bits_per_key)) * std.math.ln2));
    const bits = try A.alloc(u8, (bit_count + 7) / 8);
    @memset(bits, 0);
    return .{ .bits = bits, .hash_count = @max(hc, 1) };
}
fn bloomAdd(f: Bloom, key: []const u8) void {
    const m = f.bits.len * 8;
    const h1 = fnv1a(key);
    const h2 = mix(h1) | 1;
    var i: u32 = 0;
    while (i < f.hash_count) : (i += 1) {
        const idx = @as(usize, h1 +% i *% h2) % m;
        f.bits[idx >> 3] |= @as(u8, 1) << @intCast(idx & 7);
    }
}

// ---- LZ4 block codec -------------------------------------------------------
const SLACK: usize = 64;
const inc32 = [8]usize{ 0, 1, 2, 1, 0, 4, 4, 4 };
const dec64 = [8]isize{ 0, 0, 0, -1, -4, 1, 2, 3 };

// Match copy for a sequence that ends at least 12 bytes before `size`: lz4.c's
// LZ4_memcpy_using_offset_base. May write up to 8 bytes past `end`, into the slack.
inline fn copyMatchWild(out: []u8, o: usize, off: usize, end: usize) void {
    var d = o;
    var m = o - off;
    if (off < 8) {
        out[d] = out[m];
        out[d + 1] = out[m + 1];
        out[d + 2] = out[m + 2];
        out[d + 3] = out[m + 3];
        m += inc32[off];
        @memcpy(out[d + 4 ..][0..4], out[m..][0..4]);
        m = @intCast(@as(isize, @intCast(m)) - dec64[off]);
    } else {
        @memcpy(out[d..][0..8], out[m..][0..8]);
        m += 8;
    }
    d += 8;
    @memcpy(out[d..][0..8], out[m..][0..8]);
    if (end > d + 8) {
        d += 8;
        m += 8;
        while (d < end) : ({
            d += 8;
            m += 8;
        }) @memcpy(out[d..][0..8], out[m..][0..8]);
    }
}

fn readLenExt(src: []const u8, i: *usize, base: usize) Err!usize {
    var n = base;
    while (true) {
        if (i.* >= src.len) return error.BadBlock;
        const x = src[i.*];
        i.* += 1;
        n += x;
        if (x != 255) return n;
    }
}

// One output buffer for all blocks of an operation. Grown on demand, reset by `begin`.
var scratch: []u8 = &[_]u8{};
fn scratchFor(size: usize) Err![]u8 {
    if (scratch.len < size + SLACK) {
        if (scratch.len > 0) A.free(scratch);
        scratch = try A.alloc(u8, @max(size + SLACK, 8 * 1024));
    }
    return scratch;
}

// Decodes into the shared scratch buffer; the returned slice is valid until the next call.
// End-of-block rules per the LZ4 block format: the last 5 bytes are literals and the last
// match starts at least 12 bytes before the end, so literals reaching size-12 (or input
// end-8) must be the final sequence, and no match may end inside the last 5 bytes.
fn lz4Decompress(src: []const u8, size: usize) Err![]u8 {
    const out = try scratchFor(size);
    var i: usize = 0;
    var o: usize = 0;
    const short_iend = src.len -| 16;
    const short_oend = size -| 32;
    const last_lit_o = size -| 12;
    const last_lit_i = src.len -| 8;
    const match_oend = size -| 5;
    while (true) {
        if (i >= src.len) return error.BadBlock;
        const token = src[i];
        i += 1;
        var lit: usize = token >> 4;
        var off: usize = undefined;
        var ml: usize = (token & 15) + 4;
        if (lit != 15 and i < short_iend and o <= short_oend) {
            @memcpy(out[o..][0..16], src[i..][0..16]);
            o += lit;
            i += lit;
            off = @as(usize, src[i]) | (@as(usize, src[i + 1]) << 8);
            i += 2;
            if (off == 0 or off > o) return error.BadBlock;
            if ((token & 15) != 15 and off >= 8) {
                const m = o - off;
                @memcpy(out[o..][0..8], out[m..][0..8]);
                @memcpy(out[o + 8 ..][0..8], out[m + 8 ..][0..8]);
                @memcpy(out[o + 16 ..][0..2], out[m + 16 ..][0..2]);
                o += ml;
                continue;
            }
        } else {
            if (lit == 15) lit = try readLenExt(src, &i, 15);
            if (i + lit > src.len or o + lit > size) return error.BadBlock;
            if (o + lit > last_lit_o or i + lit > last_lit_i) {
                if (i + lit != src.len or o + lit != size) return error.BadBlock;
                @memcpy(out[o .. o + lit], src[i .. i + lit]);
                return out[0..size];
            }
            @memcpy(out[o .. o + lit], src[i .. i + lit]);
            i += lit;
            o += lit;
            off = @as(usize, src[i]) | (@as(usize, src[i + 1]) << 8);
            i += 2;
            if (off == 0 or off > o) return error.BadBlock;
        }
        if ((token & 15) == 15) ml = try readLenExt(src, &i, ml);
        const end = o + ml;
        if (end > match_oend) return error.BadBlock;
        if (end + 12 > size) {
            var m = o - off;
            var d = o;
            while (d < end) : ({
                d += 1;
                m += 1;
            }) out[d] = out[m];
        } else {
            copyMatchWild(out, o, off, end);
        }
        o = end;
    }
}

const HASH_BITS = 13;
fn hash4(b: []const u8, i: usize) usize {
    const v = std.mem.readInt(u32, b[i..][0..4], .little);
    return (v *% 2654435761) >> (32 - HASH_BITS);
}
fn putLen(out: *Bytes, n0: usize) !void {
    var n = n0;
    while (n >= 255) {
        try out.append(255);
        n -= 255;
    }
    try out.append(@intCast(n));
}
// Greedy LZ4 with the reference tricks that matter for ratio: backward match extension
// (lz4.c "catch up"), a post-match insert of i-2 (lz4_flex), and a 13-bit u16 table zeroed
// with position 0 as the empty marker (lz4.c byU16).
fn lz4Compress(src: []const u8, out: *Bytes) !void {
    var table: [1 << HASH_BITS]u16 = undefined;
    @memset(&table, 0);
    var anchor: usize = 0;
    var i: usize = 1;
    if (src.len >= 13) {
        const mflimit = src.len - 12;
        const matchlimit = src.len - 5;
        table[hash4(src, 0)] = 0;
        while (i < mflimit) {
            const h = hash4(src, i);
            var cand: usize = table[h];
            table[h] = @intCast(i);
            const hit = i - cand <= 0xffff and std.mem.readInt(u32, src[cand..][0..4], .little) == std.mem.readInt(u32, src[i..][0..4], .little);
            if (!hit) {
                i += 1;
                continue;
            }
            while (i > anchor and cand > 0 and src[i - 1] == src[cand - 1]) {
                i -= 1;
                cand -= 1;
            }
            var ml: usize = 4;
            while (i + ml < matchlimit and src[cand + ml] == src[i + ml]) ml += 1;
            const lit = i - anchor;
            const tok_lit: u8 = if (lit >= 15) 15 else @intCast(lit);
            const mlx = ml - 4;
            const tok_ml: u8 = if (mlx >= 15) 15 else @intCast(mlx);
            try out.append((tok_lit << 4) | tok_ml);
            if (lit >= 15) try putLen(out, lit - 15);
            try out.appendSlice(src[anchor..i]);
            try put16(out, @intCast(i - cand));
            if (mlx >= 15) try putLen(out, mlx - 15);
            i += ml;
            anchor = i;
            if (i >= 2) table[hash4(src, i - 2)] = @intCast(i - 2);
        }
    }
    const lit = src.len - anchor;
    const tok_lit: u8 = if (lit >= 15) 15 else @intCast(lit);
    try out.append(tok_lit << 4);
    if (lit >= 15) try putLen(out, lit - 15);
    try out.appendSlice(src[anchor..]);
}

// ---- SST encode ------------------------------------------------------------
// Sort key: 8 big-endian bytes of the key just past the prefix every key shares,
// zero-padded, so most comparisons are one integer compare. Ties fall back to the
// full key, then the input index, which makes the unstable sort deterministic and
// equal to a stable one.
const SortKey = struct { hi: u64, idx: u32 };
fn sortKeyAt(key: []const u8, skip: usize) u64 {
    var t = [_]u8{0} ** 8;
    if (key.len > skip) {
        const n = @min(8, key.len - skip);
        @memcpy(t[0..n], key[skip .. skip + n]);
    }
    return std.mem.readInt(u64, &t, .big);
}
fn skLess(entries: []const Entry, a: SortKey, b: SortKey) bool {
    if (a.hi != b.hi) return a.hi < b.hi;
    return switch (std.mem.order(u8, entries[a.idx].key, entries[b.idx].key)) {
        .lt => true,
        .gt => false,
        .eq => a.idx < b.idx,
    };
}

fn encodeBlock(block: []const Entry, out: *Bytes) !void {
    const p = if (block.len > 0) commonPrefix(block[0].key, block[block.len - 1].key) else 0;
    try put32(out, @intCast(block.len));
    try putVarint(out, p);
    if (block.len > 0) try out.appendSlice(block[0].key[0..p]);
    var offsets = Bytes.init(A);
    defer offsets.deinit();
    const base = out.items.len - 4 - varintLen(p) - p;
    for (block, 0..) |e, i| {
        if (i > 0 and i % STRIDE == 0) try put16(&offsets, @intCast(out.items.len - base));
        try out.append(if (e.put) TAG_PUT else TAG_DEL);
        try put64(out, e.seq);
        const suffix = e.key[p..];
        try putVarint(out, suffix.len);
        try out.appendSlice(suffix);
        if (e.put) {
            try putVarint(out, e.value.len);
            try out.appendSlice(e.value);
        }
    }
    try out.appendSlice(offsets.items);
}

fn encodeSst(entries_in: []const Entry, lz4: bool) ![]u8 {
    var skip: usize = if (entries_in.len > 0) entries_in[0].key.len else 0;
    for (entries_in[1..]) |e| skip = @min(skip, commonPrefix(entries_in[0].key, e.key));
    const idx = try A.alloc(SortKey, entries_in.len);
    defer A.free(idx);
    for (idx, 0..) |*x, i| x.* = .{ .hi = sortKeyAt(entries_in[i].key, skip), .idx = @intCast(i) };
    std.mem.sortUnstable(SortKey, idx, entries_in, skLess);
    const sorted = try A.alloc(Entry, entries_in.len);
    defer A.free(sorted);
    var total: usize = 0;
    for (idx, 0..) |x, i| {
        sorted[i] = entries_in[x.idx];
        total += entrySize(entries_in[x.idx]);
    }

    var starts = std.array_list.Managed(usize).init(A);
    defer starts.deinit();
    {
        var start: usize = 0;
        var keys: usize = 0;
        var overhead: usize = 0;
        for (sorted, 0..) |e, i| {
            if (i > start) {
                const p = commonPrefix(sorted[start].key, e.key);
                const n = i + 1 - start;
                const size = 4 + varintLen(p) + p + overhead + recordOverhead(e) + keys + e.key.len - n * p + offsetTableBytes(n);
                if (size > BLOCK_TARGET) {
                    try starts.append(start);
                    start = i;
                    keys = 0;
                    overhead = 0;
                }
            }
            keys += e.key.len;
            overhead += recordOverhead(e);
        }
        if (start < sorted.len or starts.items.len == 0) try starts.append(start);
    }
    const nblocks = starts.items.len;

    const bloom = try createBloom(@max(sorted.len, 1), 10);
    defer A.free(bloom.bits);
    for (sorted) |e| bloomAdd(bloom, e.key);

    var data = try Bytes.initCapacity(A, total + 64);
    defer data.deinit();
    var index = Bytes.init(A);
    defer index.deinit();
    var raw = Bytes.init(A);
    defer raw.deinit();
    var b: usize = 0;
    while (b < nblocks) : (b += 1) {
        const s = starts.items[b];
        const e = if (b + 1 < nblocks) starts.items[b + 1] else sorted.len;
        const block = sorted[s..e];
        const off = data.items.len;
        if (lz4) {
            raw.clearRetainingCapacity();
            try encodeBlock(block, &raw);
            try put32(&data, @intCast(raw.items.len));
            try lz4Compress(raw.items, &data);
        } else {
            try encodeBlock(block, &data);
        }
        const first: []const u8 = if (block.len > 0) block[0].key else "";
        const last: []const u8 = if (block.len > 0) block[block.len - 1].key else "";
        try put32(&index, @intCast(first.len));
        try index.appendSlice(first);
        try put32(&index, @intCast(last.len));
        try index.appendSlice(last);
        try put32(&index, @intCast(off));
        try put32(&index, @intCast(data.items.len - off));
    }

    var out = try Bytes.initCapacity(A, data.items.len + bloom.bits.len + index.items.len + FOOTER);
    errdefer out.deinit();
    try out.appendSlice(data.items);
    try out.appendSlice(bloom.bits);
    const index_offset = out.items.len;
    try out.appendSlice(index.items);
    const fields = [_]usize{ sorted.len, nblocks, data.items.len, bloom.bits.len, bloom.hash_count, index_offset, index.items.len, if (lz4) 1 else 0 };
    for (fields) |f| try put32(&out, @intCast(f));
    const sum = crc32(out.items);
    try put32(&out, sum);
    try put32(&out, VERSION);
    try put32(&out, MAGIC);
    return out.toOwnedSlice();
}

// ---- SST decode ------------------------------------------------------------
const Entries = std.array_list.Managed(Entry);

fn readBlockInto(block: []const u8, out: *Entries, arena: std.mem.Allocator) !void {
    if (block.len < 4) return error.Truncated;
    const count: usize = rd32(block, 0);
    var o: usize = 4;
    const end = std.math.sub(usize, block.len, offsetTableBytes(count)) catch return error.Truncated;
    const p = try readVarint(block, &o, end);
    if (o + p > end) return error.Truncated;
    const prefix = block[o .. o + p];
    o += p;
    var i: usize = 0;
    while (i < count) : (i += 1) {
        if (o >= end) return error.Truncated;
        const tag = block[o];
        o += 1;
        if (o + 8 > end) return error.Truncated;
        const seq = rd64(block, o);
        o += 8;
        const klen = try readVarint(block, &o, end);
        if (o + klen > end) return error.Truncated;
        const key = try arena.alloc(u8, p + klen);
        @memcpy(key[0..p], prefix);
        @memcpy(key[p..], block[o .. o + klen]);
        o += klen;
        switch (tag) {
            TAG_PUT => {
                const vlen = try readVarint(block, &o, end);
                if (o + vlen > end) return error.Truncated;
                const value = try arena.dupe(u8, block[o .. o + vlen]);
                o += vlen;
                try out.append(.{ .key = key, .value = value, .seq = seq, .put = true });
            },
            TAG_DEL => try out.append(.{ .key = key, .value = "", .seq = seq, .put = false }),
            else => return error.BadTag,
        }
    }
    if (o != end) return error.TrailingGarbage;
}

fn unpackBlock(framed: []const u8, lz4: bool) ![]const u8 {
    if (!lz4) return framed;
    if (framed.len < 4) return error.Truncated;
    const size: usize = rd32(framed, 0);
    return try lz4Decompress(framed[4..], size);
}

fn decodeSst(buf: []const u8, out: *Entries, arena: std.mem.Allocator) !void {
    if (buf.len < FOOTER) return error.TooShort;
    if (rd32(buf, buf.len - 4) != MAGIC) return error.BadMagic;
    if (rd32(buf, buf.len - 8) != VERSION) return error.BadVersion;
    const footer = buf.len - FOOTER;
    const f = struct {
        fn get(b: []const u8, fo: usize, i: usize) usize {
            return rd32(b, fo + 4 * i);
        }
    };
    const entry_count = f.get(buf, footer, 0);
    const block_count = f.get(buf, footer, 1);
    const bloom_off = f.get(buf, footer, 2);
    const bloom_len = f.get(buf, footer, 3);
    const index_off = f.get(buf, footer, 5);
    const index_len = f.get(buf, footer, 6);
    const codec = f.get(buf, footer, 7);
    if (index_off != bloom_off + bloom_len or index_off + index_len != footer) return error.Truncated;
    if (codec > 1) return error.BadCodec;
    const lz4 = codec == 1;
    const crc_off = footer + 32;
    if (rd32(buf, crc_off) != crc32(buf[0..crc_off])) return error.CrcMismatch;

    try out.ensureUnusedCapacity(@min(entry_count, buf.len));
    const before = out.items.len;
    var o = index_off;
    var b: usize = 0;
    while (b < block_count) : (b += 1) {
        if (o + 4 > footer) return error.Truncated;
        const fl: usize = rd32(buf, o);
        o += 4 + fl;
        if (o + 4 > footer) return error.Truncated;
        const ll: usize = rd32(buf, o);
        o += 4 + ll;
        if (o + 8 > footer) return error.Truncated;
        const off: usize = rd32(buf, o);
        o += 4;
        const len: usize = rd32(buf, o);
        o += 4;
        if (off + len > bloom_off) return error.Truncated;
        const blk = try unpackBlock(buf[off .. off + len], lz4);
        try readBlockInto(blk, out, arena);
    }
    if (o != footer) return error.TrailingGarbage;
    if (out.items.len - before != entry_count) return error.CountMismatch;
}

// ---- scan --------------------------------------------------------------------
fn contains(hay: []const u8, needle: []const u8) bool {
    return needle.len == 0 or std.mem.indexOf(u8, hay, needle) != null;
}

fn scanBlockContains(framed: []const u8, lz4: bool, patterns: []const u8) ![]u8 {
    var pats = std.array_list.Managed([]const u8).init(A);
    defer pats.deinit();
    var po: usize = 0;
    while (po < patterns.len) {
        if (po + 4 > patterns.len) return error.PatternsTruncated;
        const n: usize = rd32(patterns, po);
        po += 4;
        if (po + n > patterns.len) return error.PatternsTruncated;
        try pats.append(patterns[po .. po + n]);
        po += n;
    }
    const block = try unpackBlock(framed, lz4);
    if (block.len < 4) return error.Truncated;
    const count: usize = rd32(block, 0);
    const end = std.math.sub(usize, block.len, offsetTableBytes(count)) catch return error.Truncated;
    var o: usize = 4;
    const p = try readVarint(block, &o, end);
    if (o + p > end) return error.Truncated;
    const prefix = block[o .. o + p];
    o += p;
    var out = Bytes.init(A);
    errdefer out.deinit();
    var i: usize = 0;
    while (i < count) : (i += 1) {
        if (o >= end) return error.Truncated;
        const tag = block[o];
        o += 1;
        if (o + 8 > end) return error.Truncated;
        o += 8;
        const klen = try readVarint(block, &o, end);
        if (o + klen > end) return error.Truncated;
        const suffix = block[o .. o + klen];
        o += klen;
        switch (tag) {
            TAG_PUT => {
                const vlen = try readVarint(block, &o, end);
                if (o + vlen > end) return error.Truncated;
                const value = block[o .. o + vlen];
                o += vlen;
                var all = true;
                for (pats.items) |pt| {
                    if (!contains(value, pt)) {
                        all = false;
                        break;
                    }
                }
                if (all) {
                    try put32(&out, @intCast(p + klen));
                    try put32(&out, @intCast(vlen));
                    try out.appendSlice(prefix);
                    try out.appendSlice(suffix);
                    try out.appendSlice(value);
                }
            },
            TAG_DEL => {},
            else => return error.BadTag,
        }
    }
    if (o != end) return error.TrailingGarbage;
    return out.toOwnedSlice();
}

// ---- merge ---------------------------------------------------------------------
// Encodes one output run, then slides it down over the encoder's temporaries so the
// arena keeps only the run. Everything encodeSst allocates lies past `mark`.
fn encodeRun(entries: []const Entry, lz4: bool) ![]u8 {
    const mark = fba.end_index;
    const run = try encodeSst(entries, lz4);
    const dst = fba.buffer[mark..][0..run.len];
    std.mem.copyForwards(u8, dst, run);
    fba.end_index = mark + run.len;
    return dst;
}
fn mergeSsts(blobs: []const []const u8, drop_tombstones: bool, target_bytes: usize, lz4: bool, out: *Bytes) !u64 {
    const n = blobs.len;
    const lists = try A.alloc(Entries, n);
    defer A.free(lists);
    const pos = try A.alloc(usize, n);
    defer A.free(pos);
    for (blobs, 0..) |b, r| {
        lists[r] = Entries.init(A);
        try decodeSst(b, &lists[r], A);
        pos[r] = 0;
    }
    var dropped: u64 = 0;
    var pending = Entries.init(A);
    defer pending.deinit();
    var size: usize = 0;
    var runs = std.array_list.Managed([]const u8).init(A);
    defer runs.deinit();
    while (true) {
        var best: ?usize = null;
        for (0..n) |r| {
            if (pos[r] >= lists[r].items.len) continue;
            if (best == null or std.mem.order(u8, lists[r].items[pos[r]].key, lists[best.?].items[pos[best.?]].key) == .lt) best = r;
        }
        const r = best orelse break;
        var entry = lists[r].items[pos[r]];
        pos[r] += 1;
        while (pos[r] < lists[r].items.len and std.mem.eql(u8, lists[r].items[pos[r]].key, entry.key)) : (pos[r] += 1) entry = lists[r].items[pos[r]];
        for (0..n) |s| {
            if (s == r) continue;
            while (pos[s] < lists[s].items.len and std.mem.eql(u8, lists[s].items[pos[s]].key, entry.key)) pos[s] += 1;
        }
        if (drop_tombstones and !entry.put) {
            dropped = @max(dropped, entry.seq);
            continue;
        }
        size += entrySize(entry);
        try pending.append(entry);
        if (size >= target_bytes) {
            try runs.append(try encodeRun(pending.items, lz4));
            pending.clearRetainingCapacity();
            size = 0;
        }
    }
    if (pending.items.len > 0) try runs.append(try encodeRun(pending.items, lz4));
    var total: usize = 12;
    for (runs.items) |run| total += 4 + run.len;
    try out.ensureTotalCapacity(total);
    try put64(out, dropped);
    try put32(out, @intCast(runs.items.len));
    for (runs.items) |run| {
        try put32(out, @intCast(run.len));
        try out.appendSlice(run);
    }
    return dropped;
}

// ---- exports (flat ABI) ----------------------------------------------------------
// entries wire: [u8 tag][u64 seq][u32 klen][key][u32 vlen][value] (vlen/value only for put)
fn parseEntries(buf: []const u8, out: *Entries) !void {
    var o: usize = 0;
    while (o < buf.len) {
        if (o + 13 > buf.len) return error.Truncated;
        const tag = buf[o];
        const seq = rd64(buf, o + 1);
        const klen: usize = rd32(buf, o + 9);
        o += 13;
        if (o + klen > buf.len) return error.Truncated;
        const key = buf[o .. o + klen];
        o += klen;
        if (tag == TAG_PUT) {
            if (o + 4 > buf.len) return error.Truncated;
            const vlen: usize = rd32(buf, o);
            o += 4;
            if (o + vlen > buf.len) return error.Truncated;
            try out.append(.{ .key = key, .value = buf[o .. o + vlen], .seq = seq, .put = true });
            o += vlen;
        } else if (tag == TAG_DEL) {
            try out.append(.{ .key = key, .value = "", .seq = seq, .put = false });
        } else return error.BadTag;
    }
}
fn writeEntries(entries: []const Entry, out: *Bytes) !void {
    for (entries) |e| {
        try out.append(if (e.put) TAG_PUT else TAG_DEL);
        try put64(out, e.seq);
        try put32(out, @intCast(e.key.len));
        try out.appendSlice(e.key);
        if (e.put) {
            try put32(out, @intCast(e.value.len));
            try out.appendSlice(e.value);
        }
    }
}
fn finish(r: []const u8) i32 {
    result = r;
    return 0;
}

export fn encode_sst(p: [*]const u8, n: usize, lz4: i32) i32 {
    begin(@intFromPtr(p) + n) catch |e| return code(e);
    var entries = Entries.init(A);
    parseEntries(p[0..n], &entries) catch |e| return code(e);
    return finish(encodeSst(entries.items, lz4 != 0) catch |e| return code(e));
}

export fn decode_sst(p: [*]const u8, n: usize) i32 {
    begin(@intFromPtr(p) + n) catch |e| return code(e);
    var entries = Entries.init(A);
    decodeSst(p[0..n], &entries, A) catch |e| return code(e);
    var total: usize = 0;
    for (entries.items) |e| total += entrySize(e);
    var out = Bytes.initCapacity(A, total) catch |e| return code(e);
    writeEntries(entries.items, &out) catch |e| return code(e);
    return finish(out.items);
}

export fn lz4_decompress(p: [*]const u8, n: usize, size: usize) i32 {
    begin(@intFromPtr(p) + n) catch |e| return code(e);
    return finish(lz4Decompress(p[0..n], size) catch |e| return code(e));
}

export fn scan_block_contains(p: [*]const u8, n: usize, lz4: i32, pp: [*]const u8, pn: usize) i32 {
    begin(@max(@intFromPtr(p) + n, @intFromPtr(pp) + pn)) catch |e| return code(e);
    return finish(scanBlockContains(p[0..n], lz4 != 0, pp[0..pn]) catch |e| return code(e));
}

// blobs wire: [u32 count] then count x [u32 len][bytes]
export fn merge_ssts(p: [*]const u8, n: usize, drop_tombstones: i32, target_bytes: f64, lz4: i32) i32 {
    begin(@intFromPtr(p) + n) catch |e| return code(e);
    const buf = p[0..n];
    if (n < 4) return code(error.Truncated);
    const count: usize = rd32(buf, 0);
    if (count > (n - 4) / 4) return code(error.Truncated);
    const blobs = A.alloc([]const u8, count) catch |e| return code(e);
    var o: usize = 4;
    for (0..count) |i| {
        if (o + 4 > n) return code(error.Truncated);
        const len: usize = rd32(buf, o);
        o += 4;
        if (o + len > n) return code(error.Truncated);
        blobs[i] = buf[o .. o + len];
        o += len;
    }
    const target: usize = if (!(target_bytes > 0)) 0 else if (target_bytes >= @as(f64, @floatFromInt(std.math.maxInt(usize)))) std.math.maxInt(usize) else @intFromFloat(target_bytes);
    var out = Bytes.init(A);
    _ = mergeSsts(blobs, drop_tombstones != 0, target, lz4 != 0, &out) catch |e| return code(e);
    return finish(out.items);
}
