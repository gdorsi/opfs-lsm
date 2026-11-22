//! CRC-32 (IEEE), matching packages/kv/src/store/crc32.ts.

const std = @import("std");

/// Bytes in each of the four lanes `advance` runs at once.
const lane = 64;

/// The slicing-by-8 tables, filled on first use. Zeroed memory takes no
/// bytes in the module, where const tables would put 12 KiB in it.
var table: [8][256]u32 = std.mem.zeroes([8][256]u32);
/// What appending `lane` zero bytes does to a CRC register, one table per
/// register byte. It carries a lane's result past the lanes after it.
var shift_table: [4][256]u32 = std.mem.zeroes([4][256]u32);
var ready = false;

fn fill() void {
    @branchHint(.cold);
    // A byte's entry is the byte times x^8.
    for (&table[0], 0..) |*slot, i| slot.* = multModP(1 << (31 - 8), @intCast(i));
    for (1..8) |s| {
        for (&table[s], table[s - 1]) |*slot, prev| slot.* = (prev >> 8) ^ table[0][prev & 0xff];
    }
    const by = zeros(lane);
    for (&shift_table, 0..) |*row, k| {
        for (row, 0..) |*slot, b| slot.* = multModP(by, @as(u32, @intCast(b)) << @intCast(8 * k));
    }
    ready = true;
}

inline fn step8(c: u32, x: *const [8]u8) u32 {
    const lo = std.mem.readInt(u32, x[0..4], .little) ^ c;
    const hi = std.mem.readInt(u32, x[4..8], .little);
    return table[7][lo & 0xff] ^ table[6][(lo >> 8) & 0xff] ^ table[5][(lo >> 16) & 0xff] ^ table[4][lo >> 24] ^
        table[3][hi & 0xff] ^ table[2][(hi >> 8) & 0xff] ^ table[1][(hi >> 16) & 0xff] ^ table[0][hi >> 24];
}

/// `r` after `lane` zero bytes.
inline fn shift(r: u32) u32 {
    return shift_table[0][r & 0xff] ^ shift_table[1][(r >> 8) & 0xff] ^ shift_table[2][(r >> 16) & 0xff] ^ shift_table[3][r >> 24];
}

/// The register `c` after `data`, as slicing-by-8 computes it. It runs four
/// `lane`-byte lanes at once: their lookup chains don't depend on each other,
/// so the CPU overlaps them, and `shift` joins the four results. A lane is
/// short so that a 4 KiB block gains from it.
fn advance(c0: u32, data: []const u8) u32 {
    var c = c0;
    var i: usize = 0;
    while (data.len - i >= 4 * lane) : (i += 4 * lane) {
        const q = data[i..][0 .. 4 * lane];
        var ra = c;
        var rb: u32 = 0;
        var re: u32 = 0;
        var rd: u32 = 0;
        var j: usize = 0;
        while (j < lane) : (j += 8) {
            ra = step8(ra, q[j..][0..8]);
            rb = step8(rb, q[lane + j ..][0..8]);
            re = step8(re, q[2 * lane + j ..][0..8]);
            rd = step8(rd, q[3 * lane + j ..][0..8]);
        }
        c = shift(shift(shift(ra) ^ rb) ^ re) ^ rd;
    }
    while (data.len - i >= 8) : (i += 8) c = step8(c, data[i..][0..8]);
    for (data[i..]) |b| c = table[0][(c ^ b) & 0xff] ^ (c >> 8);
    return c;
}

/// A CRC over bytes that arrive in pieces, such as the blocks of a run.
pub const Crc32 = struct {
    state: u32 = 0xffff_ffff,

    pub fn init() Crc32 {
        if (!ready) fill();
        return .{};
    }

    pub fn update(self: *Crc32, data: []const u8) void {
        self.state = advance(self.state, data);
    }

    pub fn value(self: Crc32) u32 {
        return ~self.state;
    }

    pub fn reset(self: *Crc32) void {
        self.state = 0xffff_ffff;
    }
};

pub fn crc32(data: []const u8) u32 {
    var crc = Crc32.init();
    crc.update(data);
    return crc.value();
}

/// `a * b` modulo the CRC-32 polynomial, in its reflected bit order, where
/// bit 31 is x^0.
/// Out of line: inlined, the compiler unrolls it into each caller and folds
/// the first table of `fill` into a 1 KiB constant in the module.
noinline fn multModP(a: u32, b0: u32) u32 {
    var b = b0;
    var p: u32 = 0;
    for (0..32) |i| {
        if (a & (@as(u32, 1) << @intCast(31 - i)) != 0) p ^= b;
        b = if (b & 1 != 0) (b >> 1) ^ 0xedb8_8320 else b >> 1;
    }
    return p;
}

/// x^(8 * n) modulo the polynomial: what `n` zero bytes multiply a CRC
/// register by.
fn zeros(n0: usize) u32 {
    // By squaring x^8.
    var by: u32 = 1 << 31;
    var square: u32 = 1 << (31 - 8);
    var n = n0;
    while (n != 0) : (n >>= 1) {
        if (n & 1 != 0) by = multModP(square, by);
        square = multModP(square, square);
    }
    return by;
}

/// The CRC of `a` followed by `b`, from `crc32(a)`, `crc32(b)` and the length
/// of `b` (zlib's `crc32_combine`). A run read in pieces checks its stored
/// CRC with this: the tail's bytes arrive before the data they follow.
pub fn combine(crc_a: u32, crc_b: u32, len_b: usize) u32 {
    return multModP(zeros(len_b), crc_a) ^ crc_b;
}

fn bytewise(data: []const u8) u32 {
    var c: u32 = 0xffff_ffff;
    for (data) |b| {
        c ^= b;
        for (0..8) |_| c = if (c & 1 != 0) 0xedb88320 ^ (c >> 1) else c >> 1;
    }
    return ~c;
}

fn sample(out: []u8, shr: u5) []const u8 {
    for (out, 0..) |*b, i| b.* = @truncate(@as(u32, @intCast(i)) *% 2_654_435_761 >> shr);
    return out;
}

test "check value" {
    try std.testing.expectEqual(@as(u32, 0), crc32(""));
    try std.testing.expectEqual(@as(u32, 0xcbf4_3926), crc32("123456789"));
}

test "matches bytewise at every length and offset, and across the lane boundaries" {
    var buf: [70_000]u8 = undefined;
    const data = sample(&buf, 11);
    for (0..8) |start| {
        for (0..1024) |len| try std.testing.expectEqual(bytewise(data[start..][0..len]), crc32(data[start..][0..len]));
    }
    for ([_]usize{ 4 * lane - 9, 4 * lane, 3 * 4 * lane + 8, 4096, 4097, 65_536, 69_993 }) |len| {
        try std.testing.expectEqual(bytewise(data[3..][0..len]), crc32(data[3..][0..len]));
    }
}

test "pieces and combine give the crc of the whole" {
    var buf: [70_000]u8 = undefined;
    const data = sample(&buf, 7);
    for ([_]usize{ 0, 1, 7, 8, 9, 100, 255, 256, 257, 1023, 1024, 4097, 5000 }) |cut| {
        var crc = Crc32.init();
        crc.update(data[0..cut]);
        crc.update(data[cut..5000]);
        try std.testing.expectEqual(crc32(data[0..5000]), crc.value());
    }
    for ([_]usize{ 0, 1, 2, 44, 1000, 70_000 }) |len| {
        for ([_]usize{ 0, 1, 7, 8, 64, 255, 256, 4097, len / 2, len -| 1, len }) |c| {
            const cut = @min(c, len);
            try std.testing.expectEqual(crc32(data[0..len]), combine(crc32(data[0..cut]), crc32(data[cut..len]), len - cut));
        }
    }
}
