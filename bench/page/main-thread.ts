import type { MainThread } from "../core/types.ts";

/** One macrotask. A MessageChannel is not clamped to 4 ms the way a nested setTimeout is. */
export function yieldTask(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(null);
  });
}

/** Total Blocking Time rule: only the part of a task past 50 ms counts as blocked. */
const BUDGET_MS = 50;

const median = (xs: readonly number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

/**
 * `stamps` run from the start of the measurement to its end, with the time each rAF callback ran
 * between. The two edges catch a stall before the first or after the last frame. `vsyncs` are the
 * timestamps rAF passes in. They stay steady through a block, so their median is the display's frame interval.
 */
function summarize(durations: readonly number[], stamps: readonly number[], vsyncs: readonly number[]): MainThread {
  const gaps = stamps.slice(1).map((t, i) => Math.max(0, t - stamps[i]!));
  const frameIntervalMs = median(vsyncs.slice(1).map((t, i) => t - vsyncs[i]!));
  return {
    longTasks: durations.length,
    longestMs: Math.max(0, ...durations),
    blockedMs: durations.reduce((t, d) => t + Math.max(0, d - BUDGET_MS), 0),
    frames: vsyncs.length,
    frameIntervalMs,
    longestFrameMs: Math.max(0, ...gaps),
    droppedFrames: frameIntervalMs === 0 ? 0 : gaps.reduce((n, g) => n + Math.max(0, Math.round(g / frameIntervalMs) - 1), 0),
  };
}

/**
 * Runs `fn` and reports the main thread's long tasks (over 50 ms) and its frame gaps meanwhile.
 * Long tasks miss a 17 to 50 ms block that still drops frames, so the rAF gaps back a zero.
 */
export async function measureMainThread<T>(fn: () => Promise<T>): Promise<{ value: T; mainThread: MainThread }> {
  const durations: number[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) durations.push(e.duration);
  });
  observer.observe({ type: "longtask" });
  const stamps = [performance.now()];
  const vsyncs: number[] = [];
  // Gaps use the time the callback ran, not its timestamp argument: a block under about 40 ms
  // still shows steady 16.7 ms steps there, because Chrome hands the late frame its original vsync time.
  const tick = (vsync: number) => {
    stamps.push(performance.now());
    vsyncs.push(vsync);
    frame = requestAnimationFrame(tick);
  };
  let frame = requestAnimationFrame(tick);
  try {
    const value = await fn();
    // A task's entry is queued after it ends, so a block at the very end of `fn` is not there yet.
    await yieldTask();
    stamps.push(performance.now());
    return { value, mainThread: summarize([...durations, ...observer.takeRecords().map((e) => e.duration)], stamps, vsyncs) };
  } finally {
    cancelAnimationFrame(frame);
    observer.disconnect();
  }
}
