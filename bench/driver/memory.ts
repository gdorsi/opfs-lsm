/**
 * Memory sampling for one Chrome run: JS heap counters of the SharedWorker
 * and of each tab, wasm memory size, and renderer process RSS. Pure
 * accounting here; chrome.ts owns the CDP plumbing.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HeapPeak, MemoryPeaks } from "../core/types.ts";

const run = promisify(execFile);
const MiB = 1024 * 1024;

/** macOS `footprint` reports each process's peak since it started, so one late read catches it. Elsewhere only the current RSS. */
export const OS_KEEPS_PEAK = process.platform === "darwin";

export type HeapSample = {
  usedSize: number;
  totalSize: number;
  embedderHeapUsedSize?: number;
  backingStorageSize?: number;
};

/**
 * Installed in every worker (paused at start) and tab (new-document script) to find the wasm memories.
 * An instance's memory is whichever of its exports is a WebAssembly.Memory: kv names it `memory`,
 * wa-sqlite's minified build names it `pa`. Both `instantiate` and `instantiateStreaming` are wrapped.
 */
export const WASM_HOOK = `(() => {
  if (globalThis.__benchWasm) return;
  const refs = [];
  const Inst = WebAssembly.Instance;
  const note = (i) => {
    for (const e of Object.values((i && i.exports) || {})) if (e instanceof WebAssembly.Memory) refs.push(new WeakRef(e));
    return i;
  };
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = function (...a) {
    return instantiate.apply(this, a).then((r) => (note(r instanceof Inst ? r : r.instance), r));
  };
  const streaming = WebAssembly.instantiateStreaming;
  if (streaming) WebAssembly.instantiateStreaming = function (...a) {
    return streaming.apply(this, a).then((r) => (note(r.instance), r));
  };
  WebAssembly.Instance = new Proxy(Inst, { construct: (t, a, n) => note(Reflect.construct(t, a, n)) });
  globalThis.__benchWasm = () => {
    let max = 0;
    for (const r of refs) max = Math.max(max, r.deref()?.buffer.byteLength ?? 0);
    return max;
  };
})()`;

export class PeakTracker {
  private heap: { -readonly [K in keyof HeapPeak]: HeapPeak[K] } | null = null;
  private wasm: number | null = null;
  private total: number | null = null;

  /** One sample of one worker or tab: its heap counters and its wasm memory, read together. */
  add(s: HeapSample, wasmBytes: number): void {
    const h = (this.heap ??= { usedSize: 0, totalSize: 0, samples: 0 });
    h.usedSize = Math.max(h.usedSize, s.usedSize);
    h.totalSize = Math.max(h.totalSize, s.totalSize);
    h.samples++;
    if (s.embedderHeapUsedSize !== undefined) h.embedderHeapUsedSize = Math.max(h.embedderHeapUsedSize ?? 0, s.embedderHeapUsedSize);
    if (s.backingStorageSize !== undefined) h.backingStorageSize = Math.max(h.backingStorageSize ?? 0, s.backingStorageSize);
    this.wasm = Math.max(this.wasm ?? 0, wasmBytes);
    this.total = Math.max(this.total ?? 0, s.usedSize + (s.backingStorageSize ?? 0) + wasmBytes);
  }

  peak(): { heap: HeapPeak | null; wasmBytes: number | null; totalBytes: number | null } {
    return { heap: this.heap && { ...this.heap }, wasmBytes: this.wasm, totalBytes: this.total };
  }
}

/**
 * Memory the OS charges to one process: `phys_footprint` on macOS (resident plus
 * compressed pages, what Activity Monitor shows), RSS elsewhere. `ps` RSS alone
 * drops pages macOS compressed, which would read as memory given back.
 * `peakBytes` is `phys_footprint_peak`, the kernel's own peak since the process
 * started. It is missing where the OS does not report one.
 */
async function processMemory(pid: number): Promise<{ bytes: number; peakBytes?: number }> {
  if (OS_KEEPS_PEAK) {
    const { stdout } = await run("footprint", ["--noCategories", "-f", "bytes", "-p", String(pid)]);
    const m = /phys_footprint:\s*(\d+)/.exec(stdout);
    const peak = /phys_footprint_peak:\s*(\d+)/.exec(stdout);
    if (m) return { bytes: Number(m[1]), ...(peak && { peakBytes: Number(peak[1]) }) };
  }
  const { stdout } = await run("ps", ["-o", "rss=", "-p", String(pid)]);
  return { bytes: (Number(stdout.trim()) || 0) * 1024 };
}

/**
 * Chrome's processes by type ("browser", "renderer", "gpu-process", "utility"),
 * found through the fresh profile dir on their command lines.
 * `SystemInfo.getProcessInfo` returned a different subset on each call.
 */
async function chromeProcesses(profile: string): Promise<{ pid: number; type: string }[]> {
  const { stdout } = await run("ps", ["-A", "-o", "pid=,command="], { maxBuffer: 64 * MiB });
  const out: { pid: number; type: string }[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.includes(profile)) continue;
    const m = /^\s*(\d+)\s/.exec(line);
    if (m) out.push({ pid: Number(m[1]), type: /--type=([\w-]+)/.exec(line)?.[1] ?? "browser" });
  }
  return out;
}

export type ProcessMemory = { pid: number; type: string; bytes: number; peakBytes?: number };

/**
 * OS memory of every Chrome process. OS-level, so it reads a worker that blocks
 * its event loop. Not free: on macOS a process stalls while `footprint` reads it,
 * so storage calls in flight wait.
 */
export async function chromeMemory(profile: string): Promise<ProcessMemory[]> {
  return Promise.all(
    (await chromeProcesses(profile)).map(async ({ pid, type }) => ({
      pid,
      type,
      ...(await processMemory(pid).catch(() => ({ bytes: 0 }))),
    })),
  );
}

export function combine(workers: PeakTracker, tabs: PeakTracker, largestRendererBytes: number | null): MemoryPeaks {
  const sw = workers.peak();
  const tab = tabs.peak();
  return {
    worker: sw.heap,
    workerWasmBytes: sw.wasmBytes,
    workerTotalBytes: sw.totalBytes,
    tab: tab.heap,
    tabWasmBytes: tab.wasmBytes,
    tabTotalBytes: tab.totalBytes,
    largestRendererBytes,
  };
}
