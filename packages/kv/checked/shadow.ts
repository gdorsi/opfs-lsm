/**
 * The shadow memory behind the checked twin: one state byte per byte of the
 * twin's linear memory, and the `san` imports checked/instrument.ts calls.
 *
 *   load     every byte initialized or static
 *   store    every byte addressable (uninitialized, initialized or static);
 *            marks them initialized
 *   copy     both ranges addressable; the state bytes move with the data, so
 *            an uninitialized byte is reported where it is read, not copied
 *   fill     the range addressable; marks it initialized
 *   alloc    the payload uninitialized, the header and the tail through the
 *            block's end (the redzone and rounding) redzone
 *   realloc  the kept bytes keep their state; a moved block's old range freed
 *   free     a live block start, else a double or invalid free; the payload
 *            freed and held in a quarantine, from which the oldest block goes
 *            back to the allocator
 *
 * Static data, below the heap, is readable and writable: the CRC tables are
 * filled there on first use. Memory past every block ever placed is
 * unallocated.
 *
 * At the host boundary (abi.md): the bytes JS writes at `input_ptr` and
 * `merge_feed` count as written, and the rest of the input buffer as never
 * written; a result JS reads must be written in full; and once the twin is
 * ready, a call made with no merge session open leaves as many blocks live
 * as it found, as `merge_close` does for `merge_open`.
 */
const UNALLOCATED = 0;
const STATIC = 1;
const UNINITIALIZED = 2;
const INITIALIZED = 3;
const FREED = 4;
const REDZONE = 5;
const STATES = ["unallocated", "static", "uninitialized", "initialized", "freed", "redzone"];
/** Which states an access allows, by state. A byte past the state array reads as undefined, which no access allows. */
const READABLE = Uint8Array.of(0, 1, 0, 1, 0, 0);
const ADDRESSABLE = Uint8Array.of(0, 1, 1, 1, 0, 0);
/** How many freed blocks wait before the allocator may reuse them. */
const QUARANTINE = 256;

/** The engine's exports, in the order the twin numbers them in `leave`. */
export const BOUNDARY = [
  "input_ptr",
  "result_ptr",
  "result_len",
  "encode_sst",
  "scan_block_contains",
  "merge_open",
  "merge_pump",
  "merge_feed",
  "merge_close",
] as const;

export type SanitizerReport = {
  readonly kind: "bad-access" | "double-free" | "invalid-free" | "invalid-realloc" | "leak";
  readonly message: string;
};

/**
 * A memory error in the checked twin, thrown at the faulty access. It is not
 * a `WebAssembly.RuntimeError`, so the bridge does not take it for a trap and
 * retry on a fresh instance.
 */
class SanitizerError extends Error {
  constructor(readonly report: SanitizerReport) {
    super(`${report.kind}: ${report.message}`);
    this.name = "SanitizerError";
  }
}

/** Every twin in this process reports here, as well as throwing at the faulty access. */
const reports: SanitizerReport[] = [];

/** The violations reported since the last call. */
export function takeCheckedReports(): SanitizerReport[] {
  return reports.splice(0);
}

type Block = { readonly size: number; readonly end: number };

/** The imports of one instance of the twin. `coverage`, when given, gets the number of edges and returns the counters to bump (libFuzzer's 8-bit counters). */
export function createShadow(coverage?: (edges: number) => Uint8Array) {
  let state = new Uint8Array(0);
  let heapBase = 0;
  let counters: Uint8Array | undefined;
  const live = new Map<number, Block>();
  const quarantine: (Block & { readonly ptr: number })[] = [];
  let largest = 0;
  let work = 0;
  /** Blocks live outside a merge session; undefined until the twin is ready, and after a call that threw. */
  let expected: number | undefined;
  let session = false;
  let inCall = false;

  const fail = (kind: SanitizerReport["kind"], message: string): never => {
    const report = { kind, message };
    reports.push(report);
    throw new SanitizerError(report);
  };
  const reach = (end: number) => {
    if (state.length >= end) return;
    const grown = new Uint8Array(Math.max(end, 2 * state.length));
    grown.set(state);
    state = grown;
  };
  const check = (what: string, at: number, n: number, allowed: Uint8Array) => {
    for (let i = at, end = at + n; i < end; i++) {
      if (allowed[state[i]!] !== 1) fail("bad-access", `${what} of ${n} bytes at ${at}: byte ${i} is ${STATES[state[i] ?? UNALLOCATED]}`);
    }
  };
  const written = (at: number, n: number) => {
    if (n > 8 && at >= heapBase) state.fill(INITIALIZED, at, at + n);
    else for (let i = at; i < at + n; i++) if (state[i] !== STATIC) state[i] = INITIALIZED;
  };
  const hostWrite = (at: number, n: number) => {
    check("host write", at, n, ADDRESSABLE);
    written(at, n);
  };
  const place = (ptr: number, size: number, blockBytes: number) => {
    const end = ptr - 4 + blockBytes;
    reach(end);
    state.fill(REDZONE, ptr - 4, ptr);
    state.fill(UNINITIALIZED, ptr, ptr + size);
    state.fill(REDZONE, ptr + size, end);
    live.set(ptr, { size, end });
  };
  const settle = (after: string) => {
    if (session) return;
    if (expected === undefined) expected = live.size;
    else if (live.size !== expected) fail("leak", `${live.size - expected} blocks more live after ${after} than before`);
  };

  const imports = {
    san: {
      load(ptr: number, offset: number, n: number): number {
        work++;
        check("load", (ptr >>> 0) + offset, n, READABLE);
        return ptr;
      },
      store(ptr: number, offset: number, n: number): number {
        work++;
        const at = (ptr >>> 0) + offset;
        check("store", at, n, ADDRESSABLE);
        written(at, n);
        return ptr;
      },
      copy(dst: number, src: number, n: number): void {
        work++;
        dst >>>= 0;
        src >>>= 0;
        n >>>= 0;
        check("memory.copy read", src, n, ADDRESSABLE);
        check("memory.copy write", dst, n, ADDRESSABLE);
        state.copyWithin(dst, src, src + n);
      },
      fill(dst: number, n: number): void {
        work++;
        check("memory.fill", dst >>> 0, n >>> 0, ADDRESSABLE);
        written(dst >>> 0, n >>> 0);
      },
      alloc(ptr: number, size: number, blockBytes: number): number {
        largest = Math.max(largest, size >>> 0);
        if (ptr) place(ptr >>> 0, size >>> 0, blockBytes >>> 0);
        return ptr;
      },
      realloc(old: number, size: number, moved: number, blockBytes: number): number {
        old >>>= 0;
        size >>>= 0;
        moved >>>= 0;
        largest = Math.max(largest, size);
        if (!moved) return 0;
        if (!old) {
          place(moved, size, blockBytes >>> 0);
          return moved;
        }
        const had = live.get(old) ?? fail("invalid-realloc", `realloc of ${old}, which is not a live allocation`);
        const kept = state.slice(old, old + Math.min(had.size, size));
        if (moved !== old) state.fill(FREED, old, old + had.size);
        live.delete(old);
        place(moved, size, blockBytes >>> 0);
        state.set(kept, moved);
        return moved;
      },
      free(ptr: number): number {
        ptr >>>= 0;
        if (!ptr) return 0;
        const block = live.get(ptr);
        if (!block) {
          return quarantine.some((q) => q.ptr === ptr)
            ? fail("double-free", `free of ${ptr}, which was freed already`)
            : fail("invalid-free", `free of ${ptr}, which is not a live allocation`);
        }
        state.fill(FREED, ptr, ptr + block.size);
        live.delete(ptr);
        quarantine.push({ ptr, ...block });
        if (quarantine.length <= QUARANTINE) return 0;
        const out = quarantine.shift()!;
        state.fill(UNALLOCATED, out.ptr - 4, out.end);
        return out.ptr;
      },
      cov(id: number): void {
        work++;
        if (counters) counters[id] = counters[id] === 255 ? 1 : counters[id]! + 1;
      },
      start(base: number, edges: number): void {
        heapBase = base >>> 0;
        reach(heapBase);
        state.fill(STATIC, 0, heapBase);
        counters = coverage?.(edges);
      },
      ready(): void {
        expected = live.size;
      },
      enter(): void {
        // A call that never returned threw, and left the instance in no known state.
        if (inCall) expected = undefined;
        inCall = true;
      },
      leave(id: number, result: number, first: number, second: number): void {
        inCall = false;
        const at = result >>> 0;
        switch (BOUNDARY[id]) {
          case "input_ptr": {
            if (!at) break;
            hostWrite(at, first >>> 0);
            const block = live.get(at);
            if (block && first >>> 0 < block.size) state.fill(UNINITIALIZED, at + (first >>> 0), at + block.size);
            break;
          }
          case "merge_feed":
            if (at) hostWrite(at, second >>> 0);
            return;
          case "merge_pump":
            return;
          case "result_len":
            check("host read of the result", first >>> 0, at, READABLE);
            break;
          case "merge_open":
            if (result === 0) session = true;
            break;
          case "merge_close":
            session = false;
            break;
        }
        settle(BOUNDARY[id]!);
      },
    },
  };

  return { imports, largestAllocation: () => largest, work: () => work };
}
