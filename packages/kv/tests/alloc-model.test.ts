import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkedFile } from "../checked/engine-under-test.ts";

/**
 * The engine's allocator on its own, against a model of what it promises:
 * random allocs, reallocs and frees, after which every block is 8-byte
 * aligned, no two live blocks overlap, a realloc keeps the bytes it moves,
 * no live block's bytes change, and a walk of the heap finds blocks of at
 * least 16 bytes, in multiples of 8, that tile it exactly, with no two free
 * blocks side by side. The checked twin wraps this allocator without
 * checking its own reads and writes, so this test is what does.
 *
 *   KV_ALLOC_SEEDS=300 pnpm exec vitest run tests/alloc-model.test.ts
 */
const SEEDS = Number(process.env.KV_ALLOC_SEEDS ?? 20);
const OPS = 1500;

type Allocator = {
  memory: WebAssembly.Memory;
  alloc(size: number): number;
  realloc(ptr: number, size: number): number;
  release(ptr: number): void;
  heapStart(): number;
};

const module = new WebAssembly.Module(readFileSync(checkedFile("alloc.wasm")));

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

/** What is wrong with the heap's block list, or undefined. */
function walk(a: Allocator): string | undefined {
  const view = new DataView(a.memory.buffer);
  const end = a.memory.buffer.byteLength - 4;
  let at = a.heapStart();
  let prevFree = false;
  while (at < end) {
    const header = view.getUint32(at, true);
    const size = header & ~1;
    const free = (header & 1) === 1;
    if (size < 16 || size % 8) return `block at ${at} has size ${size}`;
    if (at + size > end) return `block at ${at} of ${size} bytes passes the heap's end ${end}`;
    if (free && prevFree) return `free blocks side by side at ${at}`;
    prevFree = free;
    at += size;
  }
  return at === end ? undefined : `blocks end at ${at}, the heap at ${end}`;
}

/** The first rule `seed`'s run of operations breaks, or undefined. */
function run(seed: number): string | undefined {
  const random = lcg(seed);
  const a = new WebAssembly.Instance(module, {}).exports as unknown as Allocator;
  const live = new Map<number, { size: number; tag: number }>();
  const bytes = () => new Uint8Array(a.memory.buffer);
  const holds = (ptr: number, size: number, tag: number) => bytes().subarray(ptr, ptr + size).every((b) => b === tag);
  for (let op = 0; op < OPS; op++) {
    const k = random();
    const ptrs = [...live.keys()];
    if (k < 0.45 || !ptrs.length) {
      const size = Math.floor(random() ** 3 * 5000) + 1;
      const ptr = a.alloc(size);
      if (!ptr) continue;
      if (ptr % 8) return `op ${op}: alloc returned ${ptr}, not 8-byte aligned`;
      const tag = (seed + op) & 0xff;
      bytes().fill(tag, ptr, ptr + size);
      live.set(ptr, { size, tag });
    } else if (k < 0.75) {
      const ptr = ptrs[Math.floor(random() * ptrs.length)]!;
      const { size, tag } = live.get(ptr)!;
      const grown = Math.floor(random() ** 3 * 8000) + 1;
      const moved = a.realloc(ptr, grown);
      if (!moved) continue;
      if (!holds(moved, Math.min(size, grown), tag)) return `op ${op}: realloc of ${ptr} to ${grown} bytes lost bytes`;
      live.delete(ptr);
      bytes().fill(tag, moved, moved + grown);
      live.set(moved, { size: grown, tag });
    } else {
      const ptr = ptrs[Math.floor(random() * ptrs.length)]!;
      a.release(ptr);
      live.delete(ptr);
    }
    const sorted = [...live].sort(([x], [y]) => x - y);
    for (let i = 1; i < sorted.length; i++) {
      const [p, { size }] = sorted[i - 1]!;
      if (p + size > sorted[i]![0] - 4) return `op ${op}: block ${p} of ${size} bytes overlaps block ${sorted[i]![0]}`;
    }
    if (op % 25 === 0) {
      for (const [ptr, { size, tag }] of live) if (!holds(ptr, size, tag)) return `op ${op}: block ${ptr} changed`;
      const broken = walk(a);
      if (broken) return `op ${op}: ${broken}`;
    }
  }
  return walk(a);
}

describe("the engine's allocator", () => {
  it("keeps its blocks apart, aligned and intact, and its heap tiled", async () => {
    const broken: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const why = run(seed);
      if (why) broken.push(`seed ${seed}: ${why}`);
      // A worker that never yields misses vitest's heartbeat, which fails a long sweep that passed.
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(broken).toEqual([]);
  }, 10_000 + SEEDS * 500);
});
