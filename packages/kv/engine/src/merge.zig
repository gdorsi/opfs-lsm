//! Compaction as a session the host drives a stop at a time, so that the
//! engine holds a window of each input instead of the whole input.
//!
//! The host opens a session with the sizes of the input runs and pumps it.
//! Each pump stops between two keys and asks the host for one thing: read
//! some bytes (`need`), take output bytes (`write`), close the output run
//! (`run_end`), give the event loop a turn (`yield`), or install the result
//! (`done`). The session owns every offset and only asks for whole blocks.
//!
//! The inputs are sources, newest first. A source is one or more runs read
//! back to back as one key-ordered stream: an L0 run, or the runs of a lower
//! level that the step overlaps. For a key, the newest source wins and, within
//! a source, the last duplicate wins, across block, read and run boundaries.
//!
//! What it holds, whatever the inputs' size: per source about `chunk_bytes` of
//! blocks (more only for a block, or a run's bloom and index, that is larger)
//! and two entries; for the output, one open block, a bloom hash and an index
//! row per key and block of the open run, and up to `chunk_bytes` plus one
//! block of bytes not yet written.

const std = @import("std");
const crc = @import("crc32.zig");
const heap = @import("heap.zig");
const sst = @import("sst.zig");

const Bytes = std.ArrayList(u8);
const gpa = &heap.gpa;

/// How a session reads, cuts and paces.
pub const Config = struct {
    /// Drop tombstones that win. Only for a step whose output is the bottom
    /// level, where no older value is left for a tombstone to hide.
    drop_tombstones: bool,
    /// Close an output run once its entries' `entrySize`s reach this.
    target_bytes: usize,
    /// About how much of each source to hold, and how many output bytes to
    /// gather before a `write`.
    chunk_bytes: usize,
    /// How much of a run's end to read first, for its footer and index.
    tail_bytes: usize,
    /// About how many input bytes to merge before a `yield`.
    yield_bytes: usize,
};

/// A read the host must answer before the next pump: `len` bytes at `offset`
/// of run `run` of source `source`. Its memory is the ABI's demand record.
pub const Demand = extern struct {
    source: u32,
    run: u32,
    offset: u32,
    len: u32,
};

/// Where a pump stopped.
pub const Stop = union(enum) {
    /// Read each of these and `feed` it, in any order, then pump.
    need: []const Demand,
    /// The next bytes of the open output run, valid until the next pump.
    write: []const u8,
    /// The open output run is complete: every byte of it was in a `write`.
    run_end: *const sst.RunEnd,
    /// About `yield_bytes` of input were merged since the pump began.
    yield,
    /// Every input was read and every run's CRC matched.
    done,
};

/// An input is not a valid run or a source's keys go backwards (an
/// `sst.Error`), a buffer could not grow, or a pump came before every demand
/// was fed, which leaves the session as it was.
pub const Error = sst.Error || error{ OutOfMemory, Unfed };

/// The sources of a session as the ABI packs them: `u32 count` then, per
/// source, `u32 run_count` and a u32 size per run.
pub const SourceList = struct {
    bytes: []const u8,
    count: usize,

    /// The list at the start of `bytes`, and where it ends, or null when it
    /// runs past the end.
    pub fn parse(bytes: []const u8) ?struct { SourceList, usize } {
        if (bytes.len < 4) return null;
        const count = sst.readU32(bytes, 0);
        var o: usize = 4;
        for (0..count) |_| {
            if (bytes.len - o < 4) return null;
            const runs = sst.readU32(bytes, o);
            o += 4;
            if (runs > (bytes.len - o) / 4) return null;
            o += 4 * @as(usize, runs);
        }
        return .{ .{ .bytes = bytes[0..o], .count = count }, o };
    }

    fn iterator(self: SourceList) Iterator {
        return .{ .bytes = self.bytes, .o = 4 };
    }

    const Iterator = struct {
        bytes: []const u8,
        o: usize,

        /// The next source's run sizes, packed.
        fn next(it: *Iterator) []const u8 {
            const runs = sst.readU32(it.bytes, it.o);
            defer it.o += 4 + 4 * @as(usize, runs);
            return it.bytes[it.o + 4 ..][0 .. 4 * @as(usize, runs)];
        }
    };
};

/// Room for what `finish` appends past `chunk_bytes`: the last block and
/// the footer. A run's bloom and index can pass it and grow `out`.
const out_slack = 2 * sst.block_target;

/// The session between pumps.
const Stage = union(enum) {
    running,
    /// `need` was returned and some demand may still be unfed.
    feeding,
    /// `write` handed out `out`, which the next pump clears.
    writing,
    done,
    /// Sticky: every later pump returns the error.
    failed: Error,
};

/// The output run: open, or not started, with `filling` bytes of entries by
/// `entrySize`, or finished into `ended`, whose bytes left in `out` go first.
const Output = union(enum) {
    filling: usize,
    finished,
};

/// What `run` stopped for. `pump` turns it into a `Stop` borrowing the
/// session.
const Next = enum { need, write, run_end, yield, done };

/// A merge of newest-first sources into key-ordered output runs.
pub const Session = struct {
    sources: []Source,
    /// Sources whose `cur` is final for its key: a binary min-heap by
    /// `(cur.key, source)`, so the smallest key and, for a key, the newest
    /// source comes first.
    heap: std.ArrayList(u32) = .empty,
    /// Sources taken off the heap whose next key is still being read.
    pending: std.ArrayList(u32) = .empty,
    /// At most one per source: a source asks for one read at a time. Like
    /// `heap` and `pending`, it holds what `open` reserved and never grows.
    demands: std.ArrayList(Demand) = .empty,
    writer: sst.Writer,
    out: Bytes = .empty,
    output: Output = .{ .filling = 0 },
    /// The run `run_end` reports.
    ended: sst.RunEnd = .{},
    drop_tombstones: bool,
    /// The base manifest's marks block (engine-abi.md, "Wire formats"),
    /// trusted: the host encoded it.
    marks: Bytes = .empty,
    target_bytes: usize,
    chunk_bytes: usize,
    yield_bytes: usize,
    /// Input block bytes opened since the pump began.
    consumed: usize = 0,
    stage: Stage = .running,

    /// A session over `list`, newest first, each a list of run sizes in key
    /// order, that drops every winner a mark of `marks` covers. Reserves the
    /// working set, so a host that cannot afford it learns so before it reads
    /// anything.
    pub fn open(config: Config, list: SourceList, marks: []const u8) Error!Session {
        var it = list.iterator();
        for (0..list.count) |_| {
            const runs = it.next();
            for (0..runs.len / 4) |r| {
                if (sst.readU32(runs, 4 * r) < sst.footer_bytes) return error.TooShort;
            }
        }
        const n = list.count;
        const sources = try gpa.*.alloc(Source, n);
        for (sources, 0..) |*source, i| source.* = .{ .reader = .init(@intCast(i), config) };
        var s: Session = .{
            .sources = sources,
            .writer = sst.Writer.init(),
            .drop_tombstones = config.drop_tombstones,
            .target_bytes = config.target_bytes,
            .chunk_bytes = @max(config.chunk_bytes, 1),
            .yield_bytes = @max(config.yield_bytes, 1),
        };
        errdefer s.deinit();
        it = list.iterator();
        for (sources) |*source| {
            try source.reader.reserve(it.next());
            try source.cur.reserve();
            try source.look.reserve();
        }
        try s.heap.ensureTotalCapacityPrecise(gpa.*, n);
        try s.pending.ensureTotalCapacityPrecise(gpa.*, n);
        for (0..n) |i| s.pending.appendAssumeCapacity(@intCast(i));
        try s.demands.ensureTotalCapacityPrecise(gpa.*, n);
        try s.out.ensureTotalCapacityPrecise(gpa.*, config.chunk_bytes +| out_slack);
        try s.marks.ensureTotalCapacityPrecise(gpa.*, marks.len);
        s.marks.appendSliceAssumeCapacity(marks);
        return s;
    }

    /// Out of line: the error path of `open` and `merge_close` would each
    /// inline a copy.
    pub noinline fn deinit(s: *Session) void {
        for (s.sources) |*source| source.deinit();
        gpa.*.free(s.sources);
        inline for (.{ &s.heap, &s.pending, &s.demands, &s.out, &s.marks }) |list| list.deinit(gpa.*);
        s.writer.deinit();
        s.ended.deinit();
    }

    /// Merge until the host has to act. After `need`, every demand must be
    /// fed first; a pump before that returns `Unfed` and changes nothing.
    /// Any other error is final: the inputs are corrupt or memory ran out,
    /// and no output of the session may be installed.
    pub fn pump(s: *Session) Error!Stop {
        switch (s.stage) {
            .failed => |e| return e,
            .done => return .done,
            .feeding => {
                for (s.sources) |*source| {
                    if (source.reader.ask == .asked) return error.Unfed;
                }
                s.demands.clearRetainingCapacity();
            },
            .writing => s.out.clearRetainingCapacity(),
            .running => {},
        }
        s.stage = .running;
        const next = s.run() catch |e| {
            s.stage = .{ .failed = e };
            return e;
        };
        switch (next) {
            .need => {
                s.stage = .feeding;
                return .{ .need = s.demands.items };
            },
            .write => {
                s.stage = .writing;
                return .{ .write = s.out.items };
            },
            .run_end => return .{ .run_end = &s.ended },
            .yield => return .yield,
            .done => {
                s.stage = .done;
                return .done;
            },
        }
    }

    /// Where the bytes of `source`'s demand go: exactly `len` bytes, to be
    /// filled before the next pump. Null when `source` has no unfed demand
    /// of that length.
    pub fn feed(s: *Session, source: usize, len: usize) ?[]u8 {
        if (s.stage != .feeding or source >= s.sources.len) return null;
        const reader = &s.sources[source].reader;
        switch (reader.ask) {
            .asked => |a| {
                if (a.len != len) return null;
                reader.ask = .{ .fed = .{ .at = a.at, .len = len } };
                return reader.chunk.items[a.at..][0..len];
            },
            else => return null,
        }
    }

    fn run(s: *Session) Error!Next {
        s.consumed = 0;
        while (true) {
            if (s.output == .finished) {
                if (s.out.items.len > 0) return .write;
                s.output = .{ .filling = 0 };
                return .run_end;
            }
            if (s.out.items.len >= s.chunk_bytes) return .write;
            try s.advancePending();
            if (s.demands.items.len > 0) {
                try s.readAhead();
                return .need;
            }
            if (s.consumed >= s.yield_bytes) return .yield;
            if (s.heap.items.len == 0) {
                if (s.writer.isEmpty()) return .done;
                s.writer.finish(&s.out, &s.ended);
                s.output = .finished;
                continue;
            }
            try s.nextKey();
        }
    }

    /// Bring every pending source back to the heap, or list what it must read.
    fn advancePending(s: *Session) Error!void {
        var i: usize = 0;
        while (i < s.pending.items.len) {
            const p = s.pending.items[i];
            switch (try s.sources[p].advance(&s.consumed)) {
                .wait => |demand| {
                    s.demands.appendAssumeCapacity(demand);
                    i += 1;
                },
                .ready => {
                    _ = s.pending.swapRemove(i);
                    s.heapPush(p);
                },
                .exhausted => _ = s.pending.swapRemove(i),
            }
        }
    }

    /// The host is about to read anyway: refill every source running low.
    fn readAhead(s: *Session) Error!void {
        for (s.sources) |*source| {
            if (try source.reader.readAhead()) |demand| s.demands.appendAssumeCapacity(demand);
        }
    }

    /// Settle the smallest key: the newest source's entry wins, the same key
    /// in older sources is shadowed, and each of those sources moves on. A
    /// winner a mark covers is dropped in any merge: every older version of
    /// its key has a smaller seq, so the same mark covers it too.
    fn nextKey(s: *Session) Error!void {
        const w = s.heapPop();
        while (s.heap.items.len > 0) {
            const t = s.heap.items[0];
            if (!std.mem.eql(u8, s.sources[t].cur.key.items, s.sources[w].cur.key.items)) break;
            _ = s.heapPop();
            s.retire(t);
        }
        const winner = &s.sources[w].cur;
        const through = marksThrough(s.marks.items, winner.key.items);
        if (through > 0 and winner.seq <= through) {
            s.retire(w);
            return;
        }
        if (!(winner.kind == .del and s.drop_tombstones)) {
            const entry = winner.entry();
            const size = (switch (s.output) {
                .filling => |size| size,
                .finished => 0,
            }) +% sst.entrySize(entry);
            try s.writer.push(entry, &s.out);
            if (size >= s.target_bytes) {
                s.writer.finish(&s.out, &s.ended);
                s.output = .finished;
            } else {
                s.output = .{ .filling = size };
            }
        }
        s.retire(w);
    }

    /// `p`'s `cur` was taken: its next key, already read, becomes `cur`.
    fn retire(s: *Session, p: u32) void {
        const source = &s.sources[p];
        if (source.head == .ready) {
            swap(&source.cur, &source.look);
            source.head = .scanning;
            s.pending.appendAssumeCapacity(p);
        } else {
            source.head = .exhausted;
        }
    }

    fn before(s: *const Session, a: u32, b: u32) bool {
        return switch (sst.order(s.sources[a].cur.key.items, s.sources[b].cur.key.items)) {
            .lt => true,
            .gt => false,
            .eq => a < b,
        };
    }

    fn heapPush(s: *Session, p: u32) void {
        s.heap.appendAssumeCapacity(p);
        const h = s.heap.items;
        var i = h.len - 1;
        while (i > 0 and s.before(h[i], h[(i - 1) / 2])) : (i = (i - 1) / 2) std.mem.swap(u32, &h[i], &h[(i - 1) / 2]);
    }

    fn heapPop(s: *Session) u32 {
        const top = s.heap.swapRemove(0);
        const h = s.heap.items;
        var i: usize = 0;
        while (true) {
            var m = i;
            for ([_]usize{ 2 * i + 1, 2 * i + 2 }) |c| {
                if (c < h.len and s.before(h[c], h[m])) m = c;
            }
            if (m == i) return top;
            std.mem.swap(u32, &h[i], &h[m]);
            i = m;
        }
    }
};

/// The highest `through` among the marks that hold `key`, 0 when none does.
/// The block was encoded by the host, so one that does not parse is a bug
/// and traps.
fn marksThrough(marks: []const u8, key: []const u8) u64 {
    @setRuntimeSafety(true);
    var through: u64 = 0;
    var o: usize = 4;
    while (o < marks.len) {
        const start = o + 4;
        const end = start + std.mem.readInt(u32, marks[o..][0..4], .little);
        const has_end = marks[end] == 1;
        var next = end + 1;
        var stop: []const u8 = &.{};
        if (has_end) {
            next += 4 + std.mem.readInt(u32, marks[next..][0..4], .little);
            stop = marks[end + 5 .. next];
        }
        if (sst.order(marks[start..end], key) != .gt and (!has_end or sst.order(key, stop) == .lt)) {
            through = @max(through, std.mem.readInt(u64, marks[next..][0..8], .little));
        }
        o = next + 16;
    }
    return through;
}

/// One input stream and the two entries it has read ahead.
const Source = struct {
    reader: Reader,
    head: Head = .start,
    cur: Slot = .{},
    look: Slot = .{},

    fn deinit(s: *Source) void {
        s.reader.deinit();
        s.cur.deinit();
        s.look.deinit();
    }

    fn advance(s: *Source, consumed: *usize) Error!Advance {
        while (true) {
            switch (s.head) {
                .start => switch (try s.reader.next(&s.cur, consumed)) {
                    .entry => s.head = .scanning,
                    .end => {
                        s.head = .exhausted;
                        return .exhausted;
                    },
                    .wait => |demand| return .{ .wait = demand },
                },
                .scanning => switch (try s.reader.next(&s.look, consumed)) {
                    .entry => switch (sst.order(s.look.key.items, s.cur.key.items)) {
                        .eq => swap(&s.cur, &s.look),
                        .gt => {
                            s.head = .ready;
                            return .ready;
                        },
                        .lt => return error.OutOfOrder,
                    },
                    .end => {
                        s.head = .last;
                        return .ready;
                    },
                    .wait => |demand| return .{ .wait = demand },
                },
                .ready, .last => return .ready,
                .exhausted => return .exhausted,
            }
        }
    }
};

/// Where a source stands in finding the last duplicate of its next key.
const Head = enum {
    /// Nothing read yet.
    start,
    /// `cur` holds a key; reading on into `look` for later duplicates.
    scanning,
    /// `cur` is the last duplicate of its key and `look` holds the next key.
    ready,
    /// `cur` is the last duplicate of the source's last key.
    last,
    /// Every entry was taken.
    exhausted,
};

const Advance = union(enum) {
    /// `cur` is final for its key: the source goes on the heap.
    ready,
    exhausted,
    wait: Demand,
};

/// Swaps whole slots: `std.mem.swap` goes a byte at a time.
fn swap(a: *Slot, b: *Slot) void {
    const t = a.*;
    a.* = b.*;
    b.* = t;
}

/// An entry copied out of a block, so it outlives the block. Its buffers
/// keep their capacity from one entry to the next.
const Slot = struct {
    key: Bytes = .empty,
    value: Bytes = .empty,
    seq: u64 = 0,
    kind: enum { put, del } = .del,

    fn reserve(s: *Slot) error{OutOfMemory}!void {
        try s.key.ensureTotalCapacityPrecise(gpa.*, 64);
        try s.value.ensureTotalCapacityPrecise(gpa.*, 256);
    }

    fn deinit(s: *Slot) void {
        s.key.deinit(gpa.*);
        s.value.deinit(gpa.*);
    }

    fn fill(s: *Slot, record: sst.Record) error{OutOfMemory}!void {
        s.key.clearRetainingCapacity();
        try s.key.ensureTotalCapacity(gpa.*, record.prefix.len + record.suffix.len);
        s.key.appendSliceAssumeCapacity(record.prefix);
        s.key.appendSliceAssumeCapacity(record.suffix);
        s.seq = record.seq;
        if (record.value) |value| {
            s.value.clearRetainingCapacity();
            try s.value.ensureTotalCapacity(gpa.*, value.len);
            s.value.appendSliceAssumeCapacity(value);
            s.kind = .put;
        } else {
            s.kind = .del;
        }
    }

    fn entry(s: *const Slot) sst.Entry {
        return .{ .key = s.key.items, .value = if (s.kind == .put) s.value.items else null, .seq = s.seq };
    }
};

/// What a source is reading of its current run.
const Read = union(enum) {
    /// The run's tail: its footer and as much of the bloom and index as fit.
    tail,
    /// The rest of the run's bloom and index. The tail already sits at the
    /// end of `chunk[0 .. size - layout.data_len]`.
    meta_rest: sst.Layout,
    /// Data blocks, in file order.
    blocks,
    /// Every run of the source was read and checked.
    done,
};

/// The source's one outstanding read.
const Ask = union(enum) {
    idle,
    /// Listed in a `need`; its bytes go to `chunk[at..][0..len]`.
    asked: struct { offset: usize, len: usize, at: usize },
    /// Fed, not yet taken in.
    fed: struct { at: usize, len: usize },
};

/// The block being walked, where it sits: `chunk[chunk_pos..][0..len]`.
const Open = struct {
    len: usize,
    walk: sst.BlockWalk,
};

const Got = union(enum) {
    entry,
    end,
    wait: Demand,
};

/// Reads a source's runs one after the other, a window at a time.
const Reader = struct {
    index: u32,
    runs: std.ArrayList(u32) = .empty,
    run: usize = 0,
    read: Read = .done,
    ask: Ask = .idle,
    chunk_bytes: usize,
    tail_bytes: usize,

    data_len: usize = 0,
    entry_count: usize = 0,
    entries_seen: usize = 0,
    /// Length of each data block, in file order. Blocks are contiguous
    /// from offset 0, so their offsets are running sums.
    blocks: std.ArrayList(u32) = .empty,
    /// Blocks asked for, arrived in `chunk`, and opened, in that order.
    requested: usize = 0,
    arrived: usize = 0,
    opened: usize = 0,
    /// Where block `requested` starts.
    next_offset: usize = 0,

    /// Arrived bytes still needed are `chunk[chunk_pos..chunk_len]`: the
    /// blocks from the open one, or from the next to open, to `arrived`.
    chunk: Bytes = .empty,
    chunk_pos: usize = 0,
    chunk_len: usize = 0,
    open: ?Open = null,

    // The run's CRC covers its data and then its meta, but the meta is read
    // first: the data's CRC streams in as blocks arrive and the two combine.
    crc_data: crc.Crc32,
    data_fed: usize = 0,
    crc_meta: u32 = 0,
    meta_crc_len: usize = 0,
    stored_crc: u32 = 0,

    fn init(index: u32, config: Config) Reader {
        return .{
            .index = index,
            .chunk_bytes = @max(config.chunk_bytes, 1),
            .tail_bytes = @max(config.tail_bytes, sst.footer_bytes),
            .crc_data = crc.Crc32.init(),
        };
    }

    /// Take the run sizes, packed, and reserve the window.
    fn reserve(r: *Reader, sizes: []const u8) error{OutOfMemory}!void {
        try r.runs.ensureTotalCapacityPrecise(gpa.*, sizes.len / 4);
        for (0..sizes.len / 4) |i| r.runs.appendAssumeCapacity(sst.readU32(sizes, 4 * i));
        if (r.runs.items.len > 0) r.read = .tail;
        try grow(&r.chunk, r.chunk_bytes);
    }

    fn deinit(r: *Reader) void {
        r.runs.deinit(gpa.*);
        r.blocks.deinit(gpa.*);
        r.chunk.deinit(gpa.*);
    }

    fn size(r: *const Reader) usize {
        return r.runs.items[r.run];
    }

    /// Read the next entry into `slot`.
    fn next(r: *Reader, slot: *Slot, consumed: *usize) Error!Got {
        while (true) {
            switch (r.read) {
                .done => return .end,
                .tail, .meta_rest => switch (r.ask) {
                    .idle => return .{ .wait = try r.askTail() },
                    .asked => |a| return .{ .wait = r.demand(a.offset, a.len) },
                    .fed => |f| {
                        r.ask = .idle;
                        try r.takeMeta(f.at, f.len);
                    },
                },
                .blocks => {
                    if (try r.walk(slot)) {
                        r.entries_seen += 1;
                        return .entry;
                    }
                    if (r.opened == r.blocks.items.len) {
                        try r.endRun();
                    } else if (r.opened < r.arrived) {
                        try r.openBlock(consumed);
                    } else switch (r.ask) {
                        .idle => return .{ .wait = try r.askData() },
                        .asked => |a| return .{ .wait = r.demand(a.offset, a.len) },
                        .fed => |f| {
                            r.ask = .idle;
                            try r.takeData(f.at, f.len);
                        },
                    }
                },
            }
        }
    }

    fn demand(r: *const Reader, offset: usize, len: usize) Demand {
        return .{ .source = r.index, .run = @intCast(r.run), .offset = @truncate(offset), .len = @truncate(len) };
    }

    /// The next record of the open block into `slot`, or false once no block
    /// is open.
    fn walk(r: *Reader, slot: *Slot) Error!bool {
        const o = if (r.open) |*o| o else return false;
        if (try o.walk.next(r.chunk.items[r.chunk_pos..][0..o.len])) |record| {
            try slot.fill(record);
            return true;
        }
        r.chunk_pos += o.len;
        r.open = null;
        return false;
    }

    fn openBlock(r: *Reader, consumed: *usize) Error!void {
        const len = r.blocks.items[r.opened];
        r.open = .{ .len = len, .walk = try sst.BlockWalk.init(r.chunk.items[r.chunk_pos..][0..len]) };
        r.opened += 1;
        consumed.* += len;
    }

    /// Ask for the run's last `tail_bytes`, which hold its footer.
    fn askTail(r: *Reader) error{OutOfMemory}!Demand {
        const run_size = r.size();
        const len = @min(run_size, r.tail_bytes);
        r.chunk_pos = 0;
        r.chunk_len = 0;
        if (len > r.chunk.items.len) try grow(&r.chunk, len);
        r.ask = .{ .asked = .{ .offset = run_size - len, .len = len, .at = 0 } };
        return r.demand(run_size - len, len);
    }

    fn takeMeta(r: *Reader, at: usize, len: usize) Error!void {
        const run_size = r.size();
        if (r.read == .meta_rest) return r.parseMeta(r.read.meta_rest, run_size - r.read.meta_rest.data_len);
        const tail_at = run_size - len;
        const layout = try sst.readFooter(r.chunk.items[at + len - sst.footer_bytes ..][0..sst.footer_bytes], run_size);
        if (layout.data_len < tail_at) {
            // The bloom or index starts before the tail: read the rest in
            // front of it, so the meta is one slice.
            const meta_len = run_size - layout.data_len;
            if (meta_len > r.chunk.items.len) try grow(&r.chunk, meta_len);
            std.mem.copyBackwards(u8, r.chunk.items[meta_len - len ..][0..len], r.chunk.items[at..][0..len]);
            r.read = .{ .meta_rest = layout };
            r.ask = .{ .asked = .{ .offset = layout.data_len, .len = tail_at - layout.data_len, .at = 0 } };
            return;
        }
        std.mem.copyForwards(u8, r.chunk.items[0..len], r.chunk.items[at..][0..len]);
        try r.parseMeta(layout, len);
        if (tail_at == 0) {
            // The tail is the whole run: keep its blocks.
            r.chunk_len = layout.data_len;
            try r.takeDataBytes(0, layout.data_len);
            r.requested = r.blocks.items.len;
            r.arrived = r.blocks.items.len;
            r.next_offset = layout.data_len;
        }
    }

    /// Check and index the run from its meta: `chunk[0..end]` ends with the
    /// run's last bytes and holds all of its bloom, index and footer.
    fn parseMeta(r: *Reader, layout: sst.Layout, end: usize) Error!void {
        const base = r.size() - end;
        const meta = r.chunk.items[layout.data_len - base .. end];
        const crc_len = layout.crc_off - layout.data_len;
        r.crc_meta = crc.crc32(meta[0..crc_len]);
        r.meta_crc_len = crc_len;
        r.stored_crc = sst.readU32(meta, crc_len);
        const index = meta[layout.index_start - layout.data_len .. layout.index_end - layout.data_len];
        try indexBlocks(index, layout.block_count, layout.data_len, &r.blocks);

        r.data_len = layout.data_len;
        r.entry_count = layout.entry_count;
        r.entries_seen = 0;
        r.requested = 0;
        r.arrived = 0;
        r.opened = 0;
        r.next_offset = 0;
        r.chunk_pos = 0;
        r.chunk_len = 0;
        r.crc_data.reset();
        r.data_fed = 0;
        r.read = .blocks;
        if (layout.data_len == 0) try r.checkCrc();
    }

    /// Ask for the next blocks: as many whole ones as fill the chunk to
    /// `chunk_bytes`, and at least one.
    fn askData(r: *Reader) error{OutOfMemory}!Demand {
        if (r.chunk_pos > 0) {
            std.mem.copyForwards(u8, r.chunk.items[0 .. r.chunk_len - r.chunk_pos], r.chunk.items[r.chunk_pos..r.chunk_len]);
            r.chunk_len -= r.chunk_pos;
            r.chunk_pos = 0;
        }
        const room = r.chunk_bytes -| r.chunk_len;
        var len: usize = 0;
        var n = r.requested;
        while (n < r.blocks.items.len) : (n += 1) {
            const block = r.blocks.items[n];
            if (n > r.requested and len + block > room) break;
            len += block;
        }
        if (r.chunk_len + len > r.chunk.items.len) try grow(&r.chunk, r.chunk_len + len);
        const offset = r.next_offset;
        r.ask = .{ .asked = .{ .offset = offset, .len = len, .at = r.chunk_len } };
        r.requested = n;
        r.next_offset += len;
        return r.demand(offset, len);
    }

    /// A source on the heap that holds less than half a chunk asks for more
    /// while the host is reading for another source anyway.
    fn readAhead(r: *Reader) error{OutOfMemory}!?Demand {
        const low = r.chunk_len - r.chunk_pos < r.chunk_bytes / 2;
        if (r.read == .blocks and r.ask == .idle and r.requested < r.blocks.items.len and low) return try r.askData();
        return null;
    }

    fn takeData(r: *Reader, at: usize, len: usize) Error!void {
        r.chunk_len = at + len;
        r.arrived = r.requested;
        try r.takeDataBytes(at, len);
    }

    fn takeDataBytes(r: *Reader, at: usize, len: usize) Error!void {
        r.crc_data.update(r.chunk.items[at..][0..len]);
        r.data_fed += len;
        if (r.data_fed == r.data_len) try r.checkCrc();
    }

    /// Every data byte has arrived, and none of the last block was used yet.
    fn checkCrc(r: *const Reader) Error!void {
        if (crc.combine(r.crc_data.value(), r.crc_meta, r.meta_crc_len) != r.stored_crc) return error.CrcMismatch;
    }

    fn endRun(r: *Reader) Error!void {
        if (r.entries_seen != r.entry_count) return error.CountMismatch;
        r.run += 1;
        r.read = if (r.run < r.runs.items.len) .tail else .done;
    }
};

/// The length of each block, from the index rows
///   u32 len | first key | u32 len | last key | u32 offset | u32 length
/// Blocks must tile the data region from 0, which a run the writer wrote
/// always does, so a block's offset is the sum before it.
fn indexBlocks(index: []const u8, count: usize, data_len: usize, blocks: *std.ArrayList(u32)) Error!void {
    blocks.clearRetainingCapacity();
    // A row is at least 16 bytes, so this bounds the rows that can parse.
    try blocks.ensureTotalCapacity(gpa.*, @min(count, index.len / 16));
    const end = index.len;
    var o: usize = 0;
    var next: usize = 0;
    for (0..count) |_| {
        for (0..2) |_| {
            if (end - o < 4) return error.Truncated;
            const len = sst.readU32(index, o);
            o += 4;
            if (len > end - o) return error.Truncated;
            o += len;
        }
        if (end - o < 8) return error.Truncated;
        const offset: usize = sst.readU32(index, o);
        const length = sst.readU32(index, o + 4);
        o += 8;
        if (offset != next or length > data_len - offset) return error.Truncated;
        next += length;
        blocks.appendAssumeCapacity(length);
    }
    if (o != end) return error.TrailingGarbage;
    if (next != data_len) return error.Truncated;
}

/// Make `buf` `len` bytes long, zeroed past what it held, without trapping
/// when memory runs out.
fn grow(buf: *Bytes, len: usize) error{OutOfMemory}!void {
    try buf.ensureTotalCapacityPrecise(gpa.*, len);
    buf.appendNTimesAssumeCapacity(0, len - buf.items.len);
}

/// Counts the allocations and in-place growths of `parent` while `on`.
const Counting = struct {
    parent: std.mem.Allocator,
    on: bool = false,
    count: usize = 0,

    fn allocator(self: *Counting) std.mem.Allocator {
        return .{ .ptr = self, .vtable = &.{ .alloc = alloc, .resize = resize, .remap = remap, .free = free } };
    }
    fn tally(ctx: *anyopaque) *std.mem.Allocator {
        const self: *Counting = @ptrCast(@alignCast(ctx));
        if (self.on) self.count += 1;
        return &self.parent;
    }
    fn alloc(ctx: *anyopaque, len: usize, a: std.mem.Alignment, ra: usize) ?[*]u8 {
        return tally(ctx).rawAlloc(len, a, ra);
    }
    fn resize(ctx: *anyopaque, m: []u8, a: std.mem.Alignment, len: usize, ra: usize) bool {
        return tally(ctx).rawResize(m, a, len, ra);
    }
    fn remap(ctx: *anyopaque, m: []u8, a: std.mem.Alignment, len: usize, ra: usize) ?[*]u8 {
        return tally(ctx).rawRemap(m, a, len, ra);
    }
    fn free(ctx: *anyopaque, m: []u8, a: std.mem.Alignment, ra: usize) void {
        const self: *Counting = @ptrCast(@alignCast(ctx));
        self.parent.rawFree(m, a, ra);
    }
};

/// A run of `entries`, as a flush writes it.
fn encode(entries: []const sst.Entry) ![]u8 {
    var out: Bytes = .empty;
    var end: sst.RunEnd = .{};
    defer end.deinit();
    sst.foldRun(entries, &out, &end);
    return out.toOwnedSlice(gpa.*);
}

test "a warm session allocates per output run, never per entry" {
    var counting: Counting = .{ .parent = std.testing.allocator };
    const saved = heap.gpa;
    heap.gpa = counting.allocator();
    defer heap.gpa = saved;

    // Three overlapping sources over 30,000 keys of one shape, so slot sizes
    // settle on the first entries: every third key, every second key in three
    // runs, and every key.
    const a = std.testing.allocator;
    var keys: [30_000][12]u8 = undefined;
    var values: [3][48]u8 = undefined;
    for (&keys, 0..) |*k, i| _ = std.fmt.bufPrint(k, "key/{d:0>8}", .{i}) catch unreachable;
    for (&values, 0..) |*v, s| @memset(v, @intCast(s));
    var runs: std.ArrayList([]u8) = .empty;
    defer {
        for (runs.items) |r| a.free(r);
        runs.deinit(a);
    }
    var sizes: std.ArrayList(u8) = .empty;
    defer sizes.deinit(a);
    var input_entries: usize = 0;
    var entries: std.ArrayList(sst.Entry) = .empty;
    defer entries.deinit(a);
    const shapes = [_]struct { every: usize, parts: usize }{ .{ .every = 3, .parts = 1 }, .{ .every = 2, .parts = 3 }, .{ .every = 1, .parts = 1 } };
    try sizes.appendSlice(a, &std.mem.toBytes(@as(u32, shapes.len)));
    for (shapes, 0..) |shape, s| {
        entries.clearRetainingCapacity();
        var i: usize = 0;
        while (i < keys.len) : (i += shape.every) try entries.append(a, .{ .key = &keys[i], .value = &values[s], .seq = i });
        input_entries += entries.items.len;
        try sizes.appendSlice(a, &std.mem.toBytes(@as(u32, @intCast(shape.parts))));
        const per = entries.items.len / shape.parts;
        for (0..shape.parts) |p| {
            const run = try encode(entries.items[p * per .. if (p + 1 == shape.parts) entries.items.len else (p + 1) * per]);
            try runs.append(a, run);
            try sizes.appendSlice(a, &std.mem.toBytes(@as(u32, @intCast(run.len))));
        }
    }
    const list, _ = SourceList.parse(sizes.items).?;
    var session = try Session.open(.{ .drop_tombstones = false, .target_bytes = 200 * 1024, .chunk_bytes = 64 * 1024, .tail_bytes = 128 * 1024, .yield_bytes = 1024 * 1024 }, list, &.{});
    defer session.deinit();
    const first_run = [_]usize{ 0, 1, 4 };

    var ended: usize = 0;
    var warm_runs: usize = 0;
    var warm_allocs: usize = 0;
    while (true) {
        const before = counting.count;
        counting.on = true;
        const stop = try session.pump();
        counting.on = false;
        switch (stop) {
            .need => |demands| {
                const copy = try a.dupe(Demand, demands);
                defer a.free(copy);
                for (copy) |d| {
                    const run = runs.items[first_run[d.source] + d.run];
                    counting.on = true;
                    const into = session.feed(d.source, d.len).?;
                    counting.on = false;
                    @memcpy(into, run[d.offset..][0..d.len]);
                }
            },
            .run_end => {
                ended += 1;
                if (ended > 2) warm_runs += 1;
            },
            .write, .yield => {},
            .done => break,
        }
        if (ended >= 2) warm_allocs += counting.count - before;
    }
    try std.testing.expect(warm_runs >= 4);
    try std.testing.expect(warm_allocs <= 4 * warm_runs + 8);
    try std.testing.expect(warm_allocs * 100 < input_entries);
}
