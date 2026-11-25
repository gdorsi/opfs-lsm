/**
 * The engine's WASM exports, flat-bytes ABI per `abi.md`. JS writes
 * packed arguments at `input_ptr`, calls one operation, and reads
 * `result_ptr`/`result_len`. Both regions live until the next call.
 */
import { Bytes } from "./buf";
import { MergeSession, NEED, OUT_OF_MEMORY, RUN_END, WRITE } from "./merge";
import { encodeSst, FOOTER_BYTES, scanBlock, TOO_SHORT, TRUNCATED } from "./sst";

const PATTERNS_TRUNCATED: i32 = -11;
const SESSION_OPEN: i32 = -12;
const NO_SESSION: i32 = -14;

const input = new Bytes();
const result = new Bytes();
/** What `result_ptr` and `result_len` report: `result`, or a session's buffer, which is not copied. */
let viewPtr: usize = 0;
let viewLen: usize = 0;
/** The one merge session a module holds. */
let session: MergeSession | null = null;

@inline function show(ptr: usize, len: usize): void {
  viewPtr = ptr;
  viewLen = len;
}

/** Show `result`, or empty it for an error status. */
function finish(status: i32): i32 {
  if (status < 0) result.clear();
  show(result.ptr, result.len);
  return status;
}

export function input_ptr(len: u32): u32 {
  if (<usize>len > input.len || !input.ptr) {
    if (!input.tryCapacity(max<usize>(len, 1))) return 0;
    input.len = max<usize>(input.len, len);
  }
  return <u32>input.ptr;
}

export function result_ptr(): u32 {
  return <u32>viewPtr;
}

export function result_len(): u32 {
  return <u32>viewLen;
}

export function encode_sst(ptr: usize, len: usize): i32 {
  return finish(encodeSst(ptr, len, result));
}

export function scan_block_contains(ptr: usize, len: usize, patPtr: usize, patLen: usize): i32 {
  let o: usize = 0;
  while (o < patLen) {
    if (patLen - o < 4 || <usize>load<u32>(patPtr + o) > patLen - o - 4) return finish(PATTERNS_TRUNCATED);
    o += 4 + <usize>load<u32>(patPtr + o);
  }
  result.clear();
  return finish(scanBlock(ptr, len, patPtr, patLen, result));
}

/**
 * Open the module's merge session. Input: source list, then the marks block
 * the session copies. Fails with -12 while a session is open, -5 for a
 * malformed list, -1 for a run shorter than a footer, and -10 when its
 * working set cannot be reserved.
 */
export function merge_open(
  ptr: usize,
  len: usize,
  dropTombstones: i32,
  targetBytes: f64,
  chunkBytes: u32,
  tailBytes: u32,
  yieldBytes: u32,
): i32 {
  show(0, 0);
  if (session) return SESSION_OPEN;
  if (len < 4) return TRUNCATED;
  const count = <usize>load<u32>(ptr);
  let o: usize = 4;
  let short = false;
  for (let i: usize = 0; i < count; i++) {
    if (len - o < 4) return TRUNCATED;
    const runs = <usize>load<u32>(ptr + o);
    o += 4;
    for (let r: usize = 0; r < runs; r++) {
      if (len - o < 4) return TRUNCATED;
      short = short || <usize>load<u32>(ptr + o) < FOOTER_BYTES;
      o += 4;
    }
  }
  if (short) return TOO_SHORT;
  const s = new MergeSession();
  s.dropTombstones = dropTombstones != 0;
  // Saturates like Rust's `as`, so Number.MAX_SAFE_INTEGER becomes the largest size.
  s.targetBytes = <usize>targetBytes;
  s.chunkBytes = max<usize>(chunkBytes, 1);
  s.yieldBytes = max<usize>(yieldBytes, 1);
  if (!s.reserve(ptr, ptr + o, len - o, chunkBytes, tailBytes)) {
    s.free();
    return OUT_OF_MEMORY;
  }
  session = s;
  return 0;
}

/**
 * Run the session to its next stop. The result holds the stop's bytes:
 * demand records for NEED, output bytes for WRITE (in the session's own
 * buffer), a run head, keys and index rows for RUN_END, nothing for YIELD
 * and DONE.
 */
export function merge_pump(): i32 {
  show(0, 0);
  const s = session;
  if (!s) return NO_SESSION;
  const stop = s.pump();
  if (stop == NEED) {
    show(s.demands.ptr, s.demands.len);
  } else if (stop == WRITE) {
    show(s.out.ptr, s.out.len);
  } else if (stop == RUN_END) {
    result.clear();
    result.reserve(16);
    result.len = 16;
    s.ended.storeHead(result.ptr);
    s.ended.appendRest(result);
    show(result.ptr, result.len);
  }
  return stop;
}

/**
 * Where the bytes of `source`'s demand go: JS writes exactly `len` bytes
 * there before the next pump. 0 when `source` has no unfed demand of that
 * length.
 */
export function merge_feed(source: u32, len: u32): u32 {
  const s = session;
  return s ? <u32>s.feed(source, len) : 0;
}

/** Drop the session and its buffers. Safe to call with none open. */
export function merge_close(): i32 {
  show(0, 0);
  const s = session;
  if (s) {
    s.free();
    session = null;
  }
  return 0;
}
