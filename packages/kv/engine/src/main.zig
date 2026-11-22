//! The engine's WASM exports, flat-bytes ABI per `engine-abi.md`. JS writes
//! packed arguments at `input_ptr`, calls one operation, and reads
//! `result_ptr`/`result_len`. Both regions live until the next call.

const std = @import("std");
const heap = @import("heap.zig");
const merge = @import("merge.zig");
const sst = @import("sst.zig");

/// Every panic in the module is a bug. JS sees a trap, and no message
/// machinery is linked.
pub const panic = std.debug.no_panic;

const Bytes = std.ArrayList(u8);

/// Every failure an operation reports.
const Failure = merge.Error || error{ PatternsTruncated, SessionOpen, NoSession };

/// The status code of each failure (engine-abi.md, "Error codes").
fn status(e: Failure) i32 {
    return switch (e) {
        error.TooShort => -1,
        error.BadMagic => -2,
        error.BadVersion => -3,
        error.CrcMismatch => -4,
        error.Truncated => -5,
        error.BadTag => -6,
        error.TrailingGarbage => -7,
        error.CountMismatch => -8,
        error.BadBlock => -9,
        error.OutOfMemory => -10,
        error.PatternsTruncated => -11,
        error.SessionOpen => -12,
        error.OutOfOrder => -13,
        error.NoSession => -14,
        error.Unfed => -15,
    };
}

const tag_put: u8 = 1;
const tag_del: u8 = 2;

/// Bytes of a run record's fixed head: entries, size, first and last key length.
const run_head = 16;

var input: Bytes = .empty;
var result: Bytes = .empty;
/// What `result_ptr` and `result_len` report: `result`, or bytes a session
/// hands out, which are not copied.
var view: []const u8 = &.{};
/// The one merge session a module holds.
var session: ?merge.Session = null;

fn bytes(ptr: u32, len: u32) []const u8 {
    if (len == 0) return &.{};
    return @as([*]const u8, @ptrFromInt(ptr))[0..len];
}

/// Show `result`, or nothing when `r` failed, and say how it went.
fn finish(r: Failure!void) i32 {
    r catch |e| {
        result.clearRetainingCapacity();
        view = result.items;
        return status(e);
    };
    view = result.items;
    return 0;
}

/// Append a run record's head and keys, from what the writer reported, to
/// `out`, whose first `run_head` bytes are the head.
fn putRunHead(out: *Bytes, end: *const sst.RunEnd) void {
    const fields = [_]usize{ end.entries, end.size, end.first_key.items.len, end.last_key.items.len };
    for (fields, 0..) |n, i| std.mem.writeInt(u32, out.items[4 * i ..][0..4], @truncate(n), .little);
    heap.appendSlice(out, end.first_key.items);
    heap.appendSlice(out, end.last_key.items);
}

/// Reads the packed arguments of an operation.
const Cursor = struct {
    buf: []const u8,
    o: usize = 0,

    fn take(c: *Cursor, n: usize) ?[]const u8 {
        if (n > c.buf.len - c.o) return null;
        defer c.o += n;
        return c.buf[c.o..][0..n];
    }

    fn int(c: *Cursor, comptime T: type) ?T {
        const b = c.take(@sizeOf(T)) orelse return null;
        return std.mem.readInt(T, b[0..@sizeOf(T)], .little);
    }
};

/// The entry records of `buf`, their keys and values read where they are.
fn parseEntries(buf: []const u8, out: *std.ArrayList(sst.Entry)) error{ Truncated, BadTag }!void {
    var c: Cursor = .{ .buf = buf };
    while (c.o < buf.len) {
        const tag = (c.take(1) orelse return error.Truncated)[0];
        const seq = c.int(u64) orelse return error.Truncated;
        const key = c.take(c.int(u32) orelse return error.Truncated) orelse return error.Truncated;
        const value = switch (tag) {
            tag_put => c.take(c.int(u32) orelse return error.Truncated) orelse return error.Truncated,
            tag_del => null,
            else => return error.BadTag,
        };
        heap.append(out, sst.Entry{ .key = key, .value = value, .seq = seq });
    }
}

export fn input_ptr(len: u32) u32 {
    if (len > input.items.len) {
        input.ensureTotalCapacityPrecise(heap.gpa, len) catch return 0;
        input.appendNTimesAssumeCapacity(0, len - input.items.len);
    }
    return @intFromPtr(input.items.ptr);
}

export fn result_ptr() u32 {
    return @intFromPtr(view.ptr);
}

export fn result_len() u32 {
    return view.len;
}

export fn encode_sst(ptr: u32, len: u32) i32 {
    var entries: std.ArrayList(sst.Entry) = .empty;
    defer entries.deinit(heap.gpa);
    parseEntries(bytes(ptr, len), &entries) catch |e| return finish(e);
    // The run is written after room for its head, so it is never copied.
    result.clearRetainingCapacity();
    heap.appendZeros(&result, run_head);
    var end: sst.RunEnd = .{};
    defer end.deinit();
    sst.foldRun(entries.items, &result, &end);
    putRunHead(&result, &end);
    return finish({});
}

export fn scan_block_contains(ptr: u32, len: u32, pat_ptr: u32, pat_len: u32) i32 {
    const patterns = sst.Patterns.parse(bytes(pat_ptr, pat_len)) orelse return finish(error.PatternsTruncated);
    result.clearRetainingCapacity();
    return finish(sst.scanBlockContains(bytes(ptr, len), patterns, &result));
}

/// Open the module's merge session. Input: source list, then the marks block
/// the session copies. Fails with -12 while a session is open, -5 for a
/// malformed list, -1 for a run shorter than a footer, and -10 when its
/// working set cannot be reserved.
export fn merge_open(ptr: u32, len: u32, drop_tombstones: i32, target_bytes: f64, chunk_bytes: u32, tail_bytes: u32, yield_bytes: u32) i32 {
    view = &.{};
    if (session != null) return status(error.SessionOpen);
    const buf = bytes(ptr, len);
    const list, const marks_at = merge.SourceList.parse(buf) orelse return status(error.Truncated);
    session = merge.Session.open(.{
        .drop_tombstones = drop_tombstones != 0,
        // Saturates, so Number.MAX_SAFE_INTEGER becomes maxInt(usize).
        .target_bytes = std.math.lossyCast(usize, target_bytes),
        .chunk_bytes = chunk_bytes,
        .tail_bytes = tail_bytes,
        .yield_bytes = yield_bytes,
    }, list, buf[marks_at..]) catch |e| return status(e);
    return 0;
}

/// Run the session to its next stop. The result holds the stop's bytes:
/// demand records for NEED, output bytes for WRITE (in the session's own
/// buffer), a run head and keys for RUN_END, nothing for YIELD and DONE.
export fn merge_pump() i32 {
    view = &.{};
    const s = if (session) |*s| s else return status(error.NoSession);
    switch (s.pump() catch |e| return status(e)) {
        .need => |demands| {
            view = std.mem.sliceAsBytes(demands);
            return 1;
        },
        .write => |out| {
            view = out;
            return 2;
        },
        .run_end => |end| {
            result.clearRetainingCapacity();
            heap.appendZeros(&result, run_head);
            putRunHead(&result, end);
            view = result.items;
            return 3;
        },
        .yield => return 4,
        .done => return 5,
    }
}

/// Where the bytes of `source`'s demand go: JS writes exactly `len` bytes
/// there before the next pump. 0 when `source` has no unfed demand of that
/// length.
export fn merge_feed(source: u32, len: u32) u32 {
    const s = if (session) |*s| s else return 0;
    const b = s.feed(source, len) orelse return 0;
    return @intFromPtr(b.ptr);
}

/// Drop the session and its buffers. Safe to call with none open.
export fn merge_close() i32 {
    view = &.{};
    if (session) |*s| s.deinit();
    session = null;
    return 0;
}
