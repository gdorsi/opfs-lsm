//! Bloom filter matching `packages/kv/src/store/bloom.ts`.

const std = @import("std");

const bits_per_key = 10;
pub const hash_count: u32 = @intFromFloat(@as(f64, bits_per_key) * std.math.ln2 + 0.5);

/// The one hash a key contributes to a filter: every probe derives from it,
/// so a writer can keep 4 bytes per key and build the filter at the end.
pub fn keyHash(data: []const u8) u32 {
    var h: u32 = 2166136261;
    for (data) |b| {
        h ^= b;
        h *%= 16777619;
    }
    return h;
}

fn mix(h0: u32) u32 {
    var h = h0;
    h ^= h >> 16;
    h *%= 0x7feb_352d;
    h ^= h >> 15;
    h *%= 0x846c_a68b;
    h ^= h >> 16;
    return h;
}

/// Bytes of the filter for `key_count` keys.
pub fn byteLen(key_count: usize) usize {
    const bits = @max(@max(key_count, 1) * bits_per_key, 64);
    return (bits + 7) / 8;
}

/// Set the bits, in a zeroed filter of `byteLen(hashes.len)` bytes, of the
/// keys whose `keyHash`es are `hashes`.
pub fn fill(bits: []u8, hashes: []const u32) void {
    const m = bits.len * 8;
    for (hashes) |h1| {
        const h2 = mix(h1) | 1;
        var i: u32 = 0;
        while (i < hash_count) : (i += 1) {
            const bit = @as(usize, h1 +% i *% h2) % m;
            bits[bit >> 3] |= @as(u8, 1) << @intCast(bit & 7);
        }
    }
}
