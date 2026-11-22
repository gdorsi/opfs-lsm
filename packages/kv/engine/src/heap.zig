//! The module's allocator. The heap starts where the module's memory ends and
//! grows with `memory.grow`; wasm memory never shrinks, so nothing goes back.
//! Freed blocks merge with free neighbours and the last block grows in place,
//! so a buffer that keeps growing reuses the memory it leaves behind.

const std = @import("std");
const builtin = @import("builtin");
const Allocator = std.mem.Allocator;
const Alignment = std.mem.Alignment;

const page = 64 * 1024;

/// Every block starts with this header. A free block keeps its free-list
/// links where its payload would be.
const Block = extern struct {
    /// Bytes of the block, header included, a multiple of `header`. Bit 0 is
    /// set while the block is in use.
    size: usize,
    /// Bytes of the block before it, 0 for the first block.
    prev_size: usize,
    next_free: ?*Block,
    prev_free: ?*Block,
};

const header = 2 * @sizeOf(usize);
const min_block = @sizeOf(Block);

fn sizeOf(b: *const Block) usize {
    return b.size & ~@as(usize, 1);
}

fn isUsed(b: *const Block) bool {
    return b.size & 1 != 0;
}

fn at(addr: usize) *Block {
    return @ptrFromInt(addr);
}

/// The block size that holds `len` payload bytes.
fn blockSize(len: usize) ?usize {
    const n = std.math.add(usize, len, 2 * header - 1) catch return null;
    return @max(n & ~@as(usize, header - 1), min_block);
}

/// A first-fit heap over the pages `Memory.grow` hands out, which must follow
/// each other. Blocks tile the heap from its start to `top`. No two free
/// blocks are neighbours, and the last block is always in use: freeing it
/// moves `top` down.
pub fn Heap(comptime Memory: type) type {
    return struct {
        const Self = @This();

        top: usize = 0,
        /// Where the memory `Memory` handed out ends.
        end: usize = 0,
        /// Size of the block that ends at `top`, 0 when there is none.
        last_size: usize = 0,
        free_list: ?*Block = null,

        pub const vtable: Allocator.VTable = .{ .alloc = alloc, .resize = resize, .remap = remap, .free = free };

        pub fn allocator(self: *Self) Allocator {
            return .{ .ptr = self, .vtable = &vtable };
        }

        fn link(self: *Self, b: *Block) void {
            b.prev_free = null;
            b.next_free = self.free_list;
            if (self.free_list) |f| f.prev_free = b;
            self.free_list = b;
        }

        fn unlink(self: *Self, b: *Block) void {
            if (b.prev_free) |p| p.next_free = b.next_free else self.free_list = b.next_free;
            if (b.next_free) |n| n.prev_free = b.prev_free;
        }

        /// Make `size` bytes past `top` usable.
        fn reach(self: *Self, size: usize) bool {
            if (self.end == 0) {
                self.top = Memory.size();
                self.end = self.top;
            }
            if (self.end - self.top >= size) return true;
            const short = size - (self.end - self.top);
            const pages = short / page + @intFromBool(short % page != 0);
            const base = Memory.grow(pages) orelse return false;
            std.debug.assert(base == self.end);
            self.end += pages * page;
            return true;
        }

        /// Take the first `size` bytes of the `have` bytes at `b`, which no
        /// block uses and which are not the last; what is left stays free.
        fn place(self: *Self, b: *Block, have: usize, size: usize) void {
            var keep = have;
            if (have - size >= min_block) {
                keep = size;
                const rest = at(@intFromPtr(b) + size);
                rest.size = have - size;
                rest.prev_size = size;
                at(@intFromPtr(rest) + rest.size).prev_size = rest.size;
                self.link(rest);
            } else {
                at(@intFromPtr(b) + have).prev_size = have;
            }
            b.size = keep | 1;
        }

        fn alloc(ctx: *anyopaque, len: usize, alignment: Alignment, _: usize) ?[*]u8 {
            const self: *Self = @ptrCast(@alignCast(ctx));
            if (alignment.toByteUnits() > header) return null;
            const size = blockSize(len) orelse return null;
            var it = self.free_list;
            while (it) |b| : (it = b.next_free) {
                if (b.size < size) continue;
                self.unlink(b);
                self.place(b, b.size, size);
                return @ptrFromInt(@intFromPtr(b) + header);
            }
            if (!self.reach(size)) return null;
            const b = at(self.top);
            b.size = size | 1;
            b.prev_size = self.last_size;
            self.top += size;
            self.last_size = size;
            return @ptrFromInt(@intFromPtr(b) + header);
        }

        fn resize(ctx: *anyopaque, memory: []u8, _: Alignment, new_len: usize, _: usize) bool {
            const self: *Self = @ptrCast(@alignCast(ctx));
            const b = at(@intFromPtr(memory.ptr) - header);
            const size = blockSize(new_len) orelse return false;
            const have = sizeOf(b);
            if (size <= have) return true;
            if (@intFromPtr(b) + have == self.top) {
                if (!self.reach(size - have)) return false;
                self.top += size - have;
                self.last_size = size;
                b.size = size | 1;
                return true;
            }
            const next = at(@intFromPtr(b) + have);
            if (isUsed(next) or have + next.size < size) return false;
            self.unlink(next);
            self.place(b, have + next.size, size);
            return true;
        }

        fn remap(ctx: *anyopaque, memory: []u8, alignment: Alignment, new_len: usize, ret: usize) ?[*]u8 {
            return if (resize(ctx, memory, alignment, new_len, ret)) memory.ptr else null;
        }

        fn free(ctx: *anyopaque, memory: []u8, _: Alignment, _: usize) void {
            const self: *Self = @ptrCast(@alignCast(ctx));
            var b = at(@intFromPtr(memory.ptr) - header);
            var size = sizeOf(b);
            if (@intFromPtr(b) + size != self.top) {
                const next = at(@intFromPtr(b) + size);
                if (!isUsed(next)) {
                    self.unlink(next);
                    size += next.size;
                }
            }
            if (b.prev_size != 0) {
                const prev = at(@intFromPtr(b) - b.prev_size);
                if (!isUsed(prev)) {
                    self.unlink(prev);
                    size += prev.size;
                    b = prev;
                }
            }
            if (@intFromPtr(b) + size == self.top) {
                self.top = @intFromPtr(b);
                self.last_size = b.prev_size;
                return;
            }
            b.size = size;
            at(@intFromPtr(b) + size).prev_size = size;
            self.link(b);
        }

        /// Assert the invariants above over every block from `base`. For tests.
        pub fn check(self: *const Self, base: usize) void {
            var free_blocks: usize = 0;
            var prev_size: usize = 0;
            var prev_free = false;
            var a = base;
            while (a < self.top) {
                const b = at(a);
                std.debug.assert(b.prev_size == prev_size);
                std.debug.assert(sizeOf(b) >= min_block and sizeOf(b) % header == 0);
                std.debug.assert(isUsed(b) or !prev_free);
                if (!isUsed(b)) free_blocks += 1;
                prev_free = !isUsed(b);
                prev_size = sizeOf(b);
                a += sizeOf(b);
            }
            std.debug.assert(a == self.top and !prev_free and prev_size == self.last_size);
            var listed: usize = 0;
            var it = self.free_list;
            while (it) |b| : (it = b.next_free) {
                std.debug.assert(!isUsed(b));
                listed += 1;
            }
            std.debug.assert(listed == free_blocks);
        }
    };
}

const WasmMemory = struct {
    fn size() usize {
        return @wasmMemorySize(0) * page;
    }
    fn grow(pages: usize) ?usize {
        const before = @wasmMemoryGrow(0, pages);
        return if (before < 0) null else @as(usize, @intCast(before)) * page;
    }
};

var wasm_heap: Heap(WasmMemory) = .{};

/// The allocator every buffer of the module uses. Tests swap in their own.
pub var gpa: Allocator = if (builtin.cpu.arch.isWasm()) wasm_heap.allocator() else std.testing.allocator;

/// Out of memory where the module has no status to report it. The host sees
/// a trap and replaces the instance (engine-abi.md, "Memory").
pub fn oom() noreturn {
    @branchHint(.cold);
    @trap();
}

/// `list.append`, trapping when memory runs out. Growth stays out of line,
/// so the common path is a compare and a store.
pub inline fn append(list: anytype, item: anytype) void {
    if (list.items.len == list.capacity) reserve(list, 1);
    list.appendAssumeCapacity(item);
}

/// `list.appendSlice`, trapping when memory runs out.
pub inline fn appendSlice(list: anytype, items: anytype) void {
    if (list.capacity - list.items.len < items.len) reserve(list, items.len);
    list.appendSliceAssumeCapacity(items);
}

/// Append `n` zero bytes, trapping when memory runs out.
pub inline fn appendZeros(list: *std.ArrayList(u8), n: usize) void {
    if (list.capacity - list.items.len < n) reserve(list, n);
    list.appendNTimesAssumeCapacity(0, n);
}

/// Append `v` as `T`, little-endian, trapping when memory runs out.
pub inline fn appendInt(list: *std.ArrayList(u8), comptime T: type, v: T) void {
    var b: [@sizeOf(T)]u8 = undefined;
    std.mem.writeInt(T, &b, v, .little);
    appendSlice(list, &b);
}

noinline fn reserve(list: anytype, n: usize) void {
    @branchHint(.cold);
    list.ensureUnusedCapacity(gpa, n) catch oom();
}

const TestMemory = struct {
    var bytes: [64 << 20]u8 align(page) = undefined;
    var used: usize = 0;
    fn size() usize {
        return @intFromPtr(&bytes);
    }
    fn grow(pages: usize) ?usize {
        if (pages * page > bytes.len - used) return null;
        defer used += pages * page;
        return @intFromPtr(&bytes) + used;
    }
};

test "blocks stay tiled, merged and listed through random allocations" {
    var heap: Heap(TestMemory) = .{};
    const a = heap.allocator();
    var prng = std.Random.DefaultPrng.init(1);
    const r = prng.random();
    var live: [64]?[]u8 = @splat(null);
    for (0..20_000) |step| {
        const i = r.uintLessThan(usize, live.len);
        const len = if (r.uintLessThan(u8, 8) == 0) r.uintLessThan(usize, 300_000) + 1 else r.uintLessThan(usize, 600) + 1;
        if (live[i]) |old| {
            for (old) |x| try std.testing.expectEqual(@as(u8, @truncate(i)), x);
            switch (r.uintLessThan(u8, 3)) {
                0 => {
                    a.free(old);
                    live[i] = null;
                },
                1 => live[i] = try a.realloc(old, len),
                else => live[i] = if (a.resize(old, len)) old.ptr[0..len] else old,
            }
        } else {
            live[i] = try a.alloc(u8, len);
        }
        if (live[i]) |s| @memset(s, @truncate(i));
        if (step % 64 == 0) heap.check(TestMemory.size());
    }
    for (&live) |*s| if (s.*) |m| a.free(m);
    heap.check(TestMemory.size());
    try std.testing.expectEqual(TestMemory.size(), heap.top);
}
