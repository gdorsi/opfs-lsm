//! SST format, version 2. Data blocks first, then the bloom filter, the
//! block index, and a 40-byte footer. Each block stores its shared key
//! prefix once; records hold the suffix and use varint lengths. Magic and
//! version sit in the last 8 bytes.
//! Must stay byte-compatible with the reader in `packages/kv/src/store/sst.ts` and
//! the reference writer in `packages/kv/tests/oracle/sst-ref.ts`.

const std = @import("std");
const bloom = @import("bloom.zig");
const Crc32 = @import("crc32.zig").Crc32;
const heap = @import("heap.zig");

const Bytes = std.ArrayList(u8);

const magic: u32 = 0x4f4c_5354; // OLST
const version: u32 = 2;
pub const footer_bytes = 40;
const tag_put: u8 = 1;
const tag_del: u8 = 2;
pub const block_target = 4 * 1024;
/// A block stores the offset of every `offset_stride`th record after
/// the first, so a get binary-searches them and walks at most
/// `offset_stride - 1` records. `packages/kv/src/store/sst.ts` uses the
/// same stride.
const offset_stride = 4;

comptime {
    std.debug.assert(block_target <= std.math.maxInt(u16)); // a block's offsets are u16
}

/// Bytes of a block's offset table: a u16 per sampled record. Only a
/// block of one record can pass the u16 range, and it has no table.
fn offsetTableBytes(count: usize) usize {
    return 2 * ((count -| 1) / offset_stride);
}

pub const Error = error{
    TooShort,
    BadMagic,
    BadVersion,
    CrcMismatch,
    Truncated,
    BadTag,
    TrailingGarbage,
    CountMismatch,
    BadBlock,
    OutOfOrder,
};

/// An entry whose bytes stay with the caller: the writer copies what it
/// keeps. `seq` is the WAL seq that wrote it, and a tombstone has no value.
pub const Entry = struct {
    key: []const u8,
    value: ?[]const u8,
    seq: u64,
};

/// What a writer reports when a run ends: what the manifest records, so
/// nobody reads the run back for it.
pub const RunEnd = struct {
    /// Entries in the run, tombstones included.
    entries: usize = 0,
    /// Bytes of the whole run, footer included.
    size: usize = 0,
    /// The smallest and largest key. Both are empty when the run has no
    /// entries, and also when its only key is empty, so `entries` says which.
    first_key: Bytes = .empty,
    last_key: Bytes = .empty,

    pub fn deinit(self: *RunEnd) void {
        self.first_key.deinit(heap.gpa);
        self.last_key.deinit(heap.gpa);
    }
};

/// Upper bound on an encoded record: tag, seq, and u32 lengths. On-disk
/// records use varints and a shared prefix, so they are never larger.
/// Compaction cuts runs by this without encoding them.
pub fn entrySize(e: Entry) usize {
    var n = 1 + 8 + 4 + e.key.len;
    if (e.value) |v| n += 4 + v.len;
    return n;
}

/// The order of two keys: their bytes, then their lengths. A byte at a time,
/// as `std.mem.order` goes, but with one test per byte where it computes a
/// three-way order per byte.
pub fn order(a: []const u8, b: []const u8) std.math.Order {
    const n = @min(a.len, b.len);
    for (a[0..n], b[0..n]) |x, y| {
        if (x != y) return if (x < y) .lt else .gt;
    }
    return std.math.order(a.len, b.len);
}

pub fn readU32(buf: []const u8, o: usize) u32 {
    return std.mem.readInt(u32, buf[o..][0..4], .little);
}

fn varintLen(v0: usize) usize {
    var v = v0;
    var n: usize = 1;
    while (v >= 0x80) : (v >>= 7) n += 1;
    return n;
}

fn appendVarint(out: *Bytes, v0: usize) void {
    var v = v0;
    while (v >= 0x80) : (v >>= 7) heap.append(out, @as(u8, @truncate(v)) | 0x80);
    heap.append(out, @as(u8, @truncate(v)));
}

/// Unsigned LEB128 of at most 5 bytes, so it fits a u32.
fn readVarint(buf: []const u8, o: *usize, end: usize) Error!usize {
    var v: usize = 0;
    var shift: u8 = 0;
    while (shift < 35) : (shift += 7) {
        if (o.* >= end) return error.Truncated;
        const b = buf[o.*];
        o.* += 1;
        v |= @as(usize, b & 0x7f) << @intCast(shift);
        if (b < 0x80) return if (v > std.math.maxInt(u32)) error.BadBlock else v;
    }
    return error.BadBlock;
}

fn commonPrefix(a: []const u8, b: []const u8) usize {
    const n = @min(a.len, b.len);
    for (a[0..n], b[0..n], 0..) |x, y, i| {
        if (x != y) return i;
    }
    return n;
}

/// A record's bytes besides its key suffix. The suffix length varint is
/// sized from the whole key, an upper bound that stays fixed as the
/// block prefix shrinks, so a block is sized from running sums.
/// `packages/kv/tests/oracle/sst-ref.ts` sizes blocks the same way.
fn recordOverhead(e: Entry) usize {
    const n = 1 + 8 + varintLen(e.key.len);
    return if (e.value) |v| n + varintLen(v.len) + v.len else n;
}

/// A record of the open block. Its key is staged cut after the `shared` bytes
/// it has in common with the block's first key, because the block's prefix is
/// only known at its last key and can only shrink. A key cut here is never
/// longer than the suffix it will be written with, so staged bytes never pass
/// the block's encoded size however long the keys are.
const Staged = struct {
    seq: u64,
    shared: usize,
    rest: usize,
    /// Null for a tombstone.
    value: ?usize,
};

/// Builds one SST in file order. `push` takes entries in key order and appends
/// each data block to `out` as soon as it is cut. `finish` appends the bloom
/// filter, the index and the footer, and reports the run. While a run is open
/// the writer holds one block, 4 bytes per key for the bloom filter, and the
/// index, however large the run's data grows.
///
/// The writer never reads `out`, so a caller can move the bytes on (to a file,
/// to a result buffer) and clear it between calls. After `finish` the writer
/// is empty and ready for the next run, with its allocations kept. Growth that
/// runs out of memory traps.
pub const Writer = struct {
    first: Bytes = .empty,
    recs: std.ArrayList(Staged) = .empty,
    staged: Bytes = .empty,
    /// Sum of the open block's key lengths and `recordOverhead`s, so the cut
    /// rule is a few additions per entry.
    keys: usize = 0,
    overhead: usize = 0,
    block: Bytes = .empty,
    offsets: Bytes = .empty,
    hashes: std.ArrayList(u32) = .empty,
    /// Index rows as the file stores them.
    index: Bytes = .empty,
    /// The bytes the run has emitted so far, and their CRC.
    crc: Crc32,
    sent: usize = 0,
    blocks: usize = 0,
    entries: usize = 0,
    first_key: Bytes = .empty,
    last_key: Bytes = .empty,

    pub fn init() Writer {
        return .{ .crc = Crc32.init() };
    }

    pub fn deinit(w: *Writer) void {
        inline for (.{ &w.first, &w.recs, &w.staged, &w.block, &w.offsets, &w.hashes, &w.index, &w.first_key, &w.last_key }) |list| {
            list.deinit(heap.gpa);
        }
    }

    /// True until the first `push` of a run.
    pub fn isEmpty(w: *const Writer) bool {
        return w.entries == 0;
    }

    fn emit(w: *Writer, out: *Bytes, bytes: []const u8) void {
        w.crc.update(bytes);
        heap.appendSlice(out, bytes);
        w.sent += bytes.len;
    }

    /// Add the next entry. Keys must not decrease; an equal key is accepted
    /// and written after the one before it. A refused entry leaves the writer
    /// as it was.
    ///
    /// A block holds at most `block_target` encoded bytes, or one entry. Its
    /// prefix shrinks as keys join it, so its size is recomputed from running
    /// key and overhead sums at each entry; when the entry would overflow it,
    /// the block is cut first and appended to `out`.
    pub fn push(w: *Writer, e: Entry, out: *Bytes) error{OutOfOrder}!void {
        const key = e.key;
        if (w.entries > 0 and order(key, w.last_key.items) == .lt) return error.OutOfOrder;
        var shared = key.len;
        if (w.recs.items.len > 0) {
            shared = commonPrefix(w.first.items, key);
            const n = w.recs.items.len + 1;
            const size = 4 + varintLen(shared) + shared + w.overhead + recordOverhead(e) + w.keys + key.len - n * shared + offsetTableBytes(n);
            if (size > block_target) {
                w.cut(out);
                shared = key.len;
            }
        }
        if (w.recs.items.len == 0) {
            w.first.clearRetainingCapacity();
            heap.appendSlice(&w.first, key);
        }
        heap.append(&w.recs, Staged{ .seq = e.seq, .shared = shared, .rest = key.len - shared, .value = if (e.value) |v| v.len else null });
        heap.appendSlice(&w.staged, key[shared..]);
        if (e.value) |v| heap.appendSlice(&w.staged, v);
        w.keys += key.len;
        w.overhead += recordOverhead(e);
        heap.append(&w.hashes, bloom.keyHash(key));
        if (w.entries == 0) heap.appendSlice(&w.first_key, key);
        w.last_key.clearRetainingCapacity();
        heap.appendSlice(&w.last_key, key);
        w.entries += 1;
    }

    /// End the run: close the open block, then append the bloom filter, the
    /// index and the footer to `out`. Together with what `push` appended,
    /// `out` holds the run.
    ///   data blocks | bloom bits | block index | footer (40 bytes)
    /// The footer is u32 entry count, block count, bloom offset, bloom length,
    /// bloom hash count, index offset, index length, then a u32 CRC of every
    /// byte before it, u32 version 2 and u32 magic. The run's keys move to
    /// `end`, whose old buffers the writer keeps for the next run.
    pub fn finish(w: *Writer, out: *Bytes, end: *RunEnd) void {
        if (w.recs.items.len > 0 or w.blocks == 0) w.cut(out);
        const data_len = w.sent;
        const bloom_len = bloom.byteLen(w.hashes.items.len);
        const bloom_at = out.items.len;
        heap.appendZeros(out, bloom_len);
        bloom.fill(out.items[bloom_at..], w.hashes.items);
        w.crc.update(out.items[bloom_at..]);
        w.sent += bloom_len;
        const index_offset = w.sent;
        w.emit(out, w.index.items);

        var footer: [28]u8 = undefined;
        const fields = [_]usize{ w.entries, w.blocks, data_len, bloom_len, bloom.hash_count, index_offset, w.index.items.len };
        for (fields, 0..) |field, i| std.mem.writeInt(u32, footer[4 * i ..][0..4], @truncate(field), .little);
        w.emit(out, &footer);
        heap.appendInt(out, u32, w.crc.value());
        heap.appendInt(out, u32, version);
        heap.appendInt(out, u32, magic);

        end.entries = w.entries;
        end.size = w.sent + 12;
        std.mem.swap(Bytes, &w.first_key, &end.first_key);
        std.mem.swap(Bytes, &w.last_key, &end.last_key);
        w.first_key.clearRetainingCapacity();
        w.last_key.clearRetainingCapacity();
        w.reset();
    }

    fn reset(w: *Writer) void {
        w.first.clearRetainingCapacity();
        w.recs.clearRetainingCapacity();
        w.staged.clearRetainingCapacity();
        w.keys = 0;
        w.overhead = 0;
        w.hashes.clearRetainingCapacity();
        w.index.clearRetainingCapacity();
        w.crc.reset();
        w.sent = 0;
        w.blocks = 0;
        w.entries = 0;
    }

    /// Write the open block, which may be empty only for a run with no
    /// entries, and append it to `out`.
    ///   u32 count | varint prefixLen | prefix | count records | u16 offsets
    /// The prefix is the longest one shared by every key in the block, which
    /// for sorted keys is the first and last key's. `offsets[j]` is where
    /// record `(j + 1) * offset_stride` starts, from the start of the block.
    /// A record is
    ///   u8 tag | u64 seq | varint suffixLen | suffix | (put) varint valLen | value
    fn cut(w: *Writer, out: *Bytes) void {
        const p = if (w.recs.items.len > 0) w.recs.items[w.recs.items.len - 1].shared else 0;
        const block = &w.block;
        block.clearRetainingCapacity();
        w.offsets.clearRetainingCapacity();
        heap.appendInt(block, u32, @truncate(w.recs.items.len));
        appendVarint(block, p);
        heap.appendSlice(block, w.first.items[0..p]);
        var at: usize = 0;
        for (w.recs.items, 0..) |r, i| {
            if (i > 0 and i % offset_stride == 0) heap.appendInt(&w.offsets, u16, @truncate(block.items.len));
            const head = w.first.items[p..r.shared];
            const rest = w.staged.items[at..][0..r.rest];
            at += r.rest;
            heap.append(block, if (r.value != null) tag_put else tag_del);
            heap.appendInt(block, u64, r.seq);
            appendVarint(block, head.len + rest.len);
            heap.appendSlice(block, head);
            heap.appendSlice(block, rest);
            if (r.value) |len| {
                appendVarint(block, len);
                heap.appendSlice(block, w.staged.items[at..][0..len]);
                at += len;
            }
        }
        heap.appendSlice(block, w.offsets.items);

        const offset = w.sent;
        w.emit(out, block.items);
        for ([_][]const u8{ w.first.items, w.last_key.items }) |key| {
            heap.appendInt(&w.index, u32, @truncate(key.len));
            heap.appendSlice(&w.index, key);
        }
        heap.appendInt(&w.index, u32, @truncate(offset));
        heap.appendInt(&w.index, u32, @truncate(block.items.len));

        w.recs.clearRetainingCapacity();
        w.staged.clearRetainingCapacity();
        w.keys = 0;
        w.overhead = 0;
        w.blocks += 1;
    }
};

fn lessOrEqual(entries: []const Entry, a: u32, b: u32) bool {
    return order(entries[a].key, entries[b].key) != .gt;
}

/// Top-down merge sort of entry numbers by key, using `buf` (same length)
/// as scratch. Stable: ties take the left run.
fn mergeSort(entries: []const Entry, v: []u32, buf: []u32) void {
    const n = v.len;
    if (n <= 16) {
        for (1..n) |i| {
            var j = i;
            while (j > 0 and !lessOrEqual(entries, v[j - 1], v[j])) : (j -= 1) std.mem.swap(u32, &v[j - 1], &v[j]);
        }
        return;
    }
    const mid = n / 2;
    mergeSort(entries, v[0..mid], buf[0..mid]);
    mergeSort(entries, v[mid..], buf[mid..]);
    if (lessOrEqual(entries, v[mid - 1], v[mid])) return;
    @memcpy(buf, v);
    var i: usize = 0;
    var j = mid;
    for (v) |*slot| {
        if (j == n or (i < mid and lessOrEqual(entries, buf[i], buf[j]))) {
            slot.* = buf[i];
            i += 1;
        } else {
            slot.* = buf[j];
            j += 1;
        }
    }
}

/// Fold writes into the run a flush publishes, appending it to `out`:
/// `entries` in the order they were written, in any key order. The run holds
/// each key once, as its last entry. Equal keys keep their order in `entries`.
pub fn foldRun(entries: []const Entry, out: *Bytes, end: *RunEnd) void {
    const ids = heap.gpa.alloc(u32, entries.len) catch heap.oom();
    defer heap.gpa.free(ids);
    for (ids, 0..) |*o, i| o.* = @intCast(i);
    var sorted = true;
    for (0..entries.len -| 1) |i| {
        if (!lessOrEqual(entries, @intCast(i), @intCast(i + 1))) {
            sorted = false;
            break;
        }
    }
    if (!sorted) {
        const buf = heap.gpa.alloc(u32, entries.len) catch heap.oom();
        defer heap.gpa.free(buf);
        mergeSort(entries, ids, buf);
    }
    var writer = Writer.init();
    defer writer.deinit();
    for (ids, 0..) |i, at| {
        if (at + 1 < ids.len and std.mem.eql(u8, entries[ids[at + 1]].key, entries[i].key)) continue;
        writer.push(entries[i], out) catch unreachable; // sorted entries are in order
    }
    writer.finish(out, end);
}

/// A record of a data block, its key split the way the block stores it.
pub const Record = struct {
    seq: u64,
    prefix: []const u8,
    suffix: []const u8,
    /// Null for a tombstone.
    value: ?[]const u8,
};

/// A cursor over the records of one data block:
///   u32 count | varint prefixLen | prefix | records | u16 offsets
/// It holds positions only, so the block may move between calls; `next` must
/// be given the bytes `init` read. Lengths are checked as `len > end - o` with
/// `o <= end`, never as `o + len > end`, which wraps for a length near
/// `maxInt(u32)` on wasm32.
pub const BlockWalk = struct {
    o: usize,
    /// Where the offset table starts, which the records must end at.
    end: usize,
    left: usize,
    prefix_at: usize,
    prefix_len: usize,

    pub fn init(block: []const u8) Error!BlockWalk {
        if (block.len < 4) return error.Truncated;
        const table = offsetTableBytes(readU32(block, 0));
        if (table > block.len) return error.Truncated;
        const end = block.len - table;
        var o: usize = 4;
        const prefix_len = try readVarint(block, &o, end);
        if (prefix_len > end - o) return error.Truncated;
        return .{ .o = o + prefix_len, .end = end, .left = readU32(block, 0), .prefix_at = o, .prefix_len = prefix_len };
    }

    /// The next record, or null after the last, once the records are seen
    /// to end exactly where the offset table starts.
    pub fn next(self: *BlockWalk, block: []const u8) Error!?Record {
        var o = self.o;
        const end = self.end;
        if (self.left == 0) return if (o == end) null else error.TrailingGarbage;
        if (o >= end) return error.Truncated;
        const tag = block[o];
        o += 1;
        if (end - o < 8) return error.Truncated;
        const seq = std.mem.readInt(u64, block[o..][0..8], .little);
        o += 8;
        const key_len = try readVarint(block, &o, end);
        if (key_len > end - o) return error.Truncated;
        const suffix = block[o..][0..key_len];
        o += key_len;
        var value: ?[]const u8 = null;
        switch (tag) {
            tag_put => {
                const val_len = try readVarint(block, &o, end);
                if (val_len > end - o) return error.Truncated;
                value = block[o..][0..val_len];
                o += val_len;
            },
            tag_del => {},
            else => return error.BadTag,
        }
        self.o = o;
        self.left -= 1;
        return .{ .seq = seq, .prefix = block[self.prefix_at..][0..self.prefix_len], .suffix = suffix, .value = value };
    }
};

/// True when `hay` holds `needle` as a contiguous run of bytes.
fn contains(hay: []const u8, needle: []const u8) bool {
    if (needle.len == 0) return true;
    var from: usize = 0;
    while (std.mem.indexOfScalarPos(u8, hay, from, needle[0])) |i| {
        const at = i + 1;
        if (hay.len - at >= needle.len - 1 and std.mem.eql(u8, hay[at..][0 .. needle.len - 1], needle[1..])) return true;
        from = at;
    }
    return false;
}

/// A pattern list as the ABI packs it: repeated `u32 len · bytes`.
pub const Patterns = struct {
    bytes: []const u8,

    /// The list, or null when a length runs past its end.
    pub fn parse(bytes: []const u8) ?Patterns {
        var o: usize = 0;
        while (o < bytes.len) {
            if (bytes.len - o < 4) return null;
            const n = readU32(bytes, o);
            o += 4;
            if (n > bytes.len - o) return null;
            o += n;
        }
        return .{ .bytes = bytes };
    }

    fn allIn(self: Patterns, hay: []const u8) bool {
        var o: usize = 0;
        while (o < self.bytes.len) {
            const n = readU32(self.bytes, o);
            if (!contains(hay, self.bytes[o + 4 ..][0..n])) return false;
            o += 4 + n;
        }
        return true;
    }
};

/// The puts of one data block of a run whose value contains every pattern.
/// Records are read in place, so a block that misses allocates nothing. Hits
/// are appended to `out`: `u32 key_len, u32 value_len, u64 seq, key, value`,
/// little-endian, in key order.
pub fn scanBlockContains(block: []const u8, patterns: Patterns, out: *Bytes) Error!void {
    var walk = try BlockWalk.init(block);
    while (try walk.next(block)) |record| {
        const value = record.value orelse continue;
        if (!patterns.allIn(value)) continue;
        heap.appendInt(out, u32, @truncate(record.prefix.len + record.suffix.len));
        heap.appendInt(out, u32, @truncate(value.len));
        heap.appendInt(out, u64, record.seq);
        heap.appendSlice(out, record.prefix);
        heap.appendSlice(out, record.suffix);
        heap.appendSlice(out, value);
    }
}

/// Where the sections of a run are, as offsets into the run. Data starts at
/// 0. `crc_off` holds the CRC of every byte before it.
pub const Layout = struct {
    entry_count: usize,
    block_count: usize,
    data_len: usize,
    index_start: usize,
    index_end: usize,
    crc_off: usize,
};

/// Check the last `footer_bytes` of a run of `size` bytes and say where its
/// sections are. The footer is 7 u32 fields, then CRC, version, and magic.
pub fn readFooter(footer: []const u8, size: usize) Error!Layout {
    if (readU32(footer, footer_bytes - 4) != magic) return error.BadMagic;
    if (readU32(footer, footer_bytes - 8) != version) return error.BadVersion;
    const at = size - footer_bytes;
    const bloom_offset: usize = readU32(footer, 8);
    const index_offset: usize = readU32(footer, 20);
    const bloom_end, const bloom_wrapped = @addWithOverflow(bloom_offset, @as(usize, readU32(footer, 12)));
    const index_end, const index_wrapped = @addWithOverflow(index_offset, @as(usize, readU32(footer, 24)));
    if (bloom_wrapped != 0 or bloom_end != index_offset or index_wrapped != 0 or index_end != at) return error.Truncated;
    return .{
        .entry_count = readU32(footer, 0),
        .block_count = readU32(footer, 4),
        .data_len = bloom_offset,
        .index_start = index_offset,
        .index_end = at,
        .crc_off = at + 28,
    };
}
