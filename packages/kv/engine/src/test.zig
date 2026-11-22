//! Native tests: `zig test src/test.zig`. The wasm exports are covered by
//! packages/kv/tests/engine-differential.test.ts.

test {
    _ = @import("crc32.zig");
    _ = @import("heap.zig");
    _ = @import("merge.zig");
}
