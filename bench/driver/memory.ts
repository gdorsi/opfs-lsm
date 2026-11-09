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

export type HeapSample = {
  usedSize: number;
  totalSize: number;
  embedderHeapUsedSize?: number;
  backingStorageSize?: number;
};

/** Installed in every SharedWorker (paused at start) and tab (new-document script) to find the wasm memories. */
export const WASM_HOOK = `(() => {
  if (globalThis.__benchWasm) return;
  const refs = [];
  const Inst = WebAssembly.Instance;
  const note = (i) => {
    const m = i && i.exports && i.exports.memory;
    if (m instanceof WebAssembly.Memory) refs.push(new WeakRef(m));
    return i;
  };
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = function (...a) {
    return instantiate.apply(this, a).then((r) => (note(r instanceof Inst ? r : r.instance), r));
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

  addHeap(s: HeapSample): void {
    const h = (this.heap ??= { usedSize: 0, totalSize: 0, samples: 0 });
    h.usedSize = Math.max(h.usedSize, s.usedSize);
    h.totalSize = Math.max(h.totalSize, s.totalSize);
    h.samples++;
    if (s.embedderHeapUsedSize !== undefined) h.embedderHeapUsedSize = Math.max(h.embedderHeapUsedSize ?? 0, s.embedderHeapUsedSize);
    if (s.backingStorageSize !== undefined) h.backingStorageSize = Math.max(h.backingStorageSize ?? 0, s.backingStorageSize);
  }

  addWasm(bytes: number): void {
    this.wasm = Math.max(this.wasm ?? 0, bytes);
  }

  peak(): { heap: HeapPeak | null; wasmBytes: number | null } {
    return { heap: this.heap && { ...this.heap }, wasmBytes: this.wasm };
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
  if (process.platform === "darwin") {
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
 * OS memory of every Chrome process. OS-level, so it keeps sampling while a
 * worker blocks its event loop. Not free: reading the renderers every 100 ms
 * made kv's write phases take 12 to 45% longer, so the sampler asks once a second.
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

export function combine(sharedWorker: PeakTracker, tabs: PeakTracker, largestRendererBytes: number | null): MemoryPeaks {
  const sw = sharedWorker.peak();
  const tab = tabs.peak();
  return {
    sharedWorker: sw.heap,
    sharedWorkerWasmBytes: sw.wasmBytes,
    tab: tab.heap,
    tabWasmBytes: tab.wasmBytes,
    largestRendererBytes,
  };
}
