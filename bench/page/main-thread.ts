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

/** The idle rAF callbacks calibration waits for: two steps. */
const CALIBRATION_FRAMES = 3;
/** Calibration gives up on a page that paints no frames (a hidden tab). */
const CALIBRATION_TIMEOUT_MS = 500;

/**
 * The display's frame interval before `fn` runs, from the vsync timestamps of a few idle rAF callbacks:
 * the smallest step. Infinity when the page paints too few frames to say.
 */
function calibrateFrameInterval(): Promise<number> {
  return new Promise((resolve) => {
    const vsyncs: number[] = [];
    let frame = 0;
    const done = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      resolve(smallestStep(vsyncs));
    };
    const timer = setTimeout(done, CALIBRATION_TIMEOUT_MS);
    const tick = (vsync: number) => {
      vsyncs.push(vsync);
      if (vsyncs.length < CALIBRATION_FRAMES) frame = requestAnimationFrame(tick);
      else done();
    };
    frame = requestAnimationFrame(tick);
  });
}

function smallestStep(vsyncs: readonly number[]): number {
  let smallest = Infinity;
  for (let i = 1; i < vsyncs.length; i++) smallest = Math.min(smallest, vsyncs[i]! - vsyncs[i - 1]!);
  return smallest;
}

/**
 * `stamps` run from the start of the measurement to its end, with the time each rAF callback ran
 * between. The two edges catch a stall before the first or after the last frame. `vsyncs` are the
 * timestamps rAF passes in. They stay steady through a block, so their steps show the display's frame
 * interval, until a long block makes Chrome skip vsyncs and every step grows. The interval is the smallest
 * step of the calibration before the run and of the run itself: a median over the run reads 33.3 ms
 * when most frames are late, and a run with one frame has no step at all.
 */
export function summarize(durations: readonly number[], stamps: readonly number[], vsyncs: readonly number[], calibrated = Infinity): MainThread {
  const gaps = stamps.slice(1).map((t, i) => Math.max(0, t - stamps[i]!));
  const found = Math.min(calibrated, smallestStep(vsyncs));
  const frameIntervalMs = Number.isFinite(found) ? found : 0;
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
  const calibrated = await calibrateFrameInterval();
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
    return { value, mainThread: summarize([...durations, ...observer.takeRecords().map((e) => e.duration)], stamps, vsyncs, calibrated) };
  } finally {
    cancelAnimationFrame(frame);
    observer.disconnect();
  }
}
