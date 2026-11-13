/**
 * Does the bench page's main-thread collector see a planted block? Chrome only.
 *
 *   node bench/probes/main-thread.ts
 *
 * Loads the bench page in headless Chrome and runs `__bench.measureMainThread`
 * three times. It passes when:
 * - 300 ms idle drops no frame and shows a frame interval of 8 to 34 ms, so
 *   requestAnimationFrame runs steadily in headless Chrome;
 * - a 30 ms busy loop between idle stretches drops one or two frames, has a
 *   longest frame of 30 to 70 ms and no long task;
 * - a 200 ms busy loop, a 20 ms one and 300 ms of 5 ms busy slices that each
 *   yield a macrotask give exactly one long task, 200 to 260 ms long, with
 *   150 to 210 ms blocked.
 */
import path from "node:path";
import type { MainThread } from "../core/types.ts";
import { BENCH_DIR, buildBench } from "../driver/build.ts";
import { launchChrome } from "../driver/chrome.ts";
import { DATA_DIR } from "../driver/data.ts";
import { serve } from "../driver/serve.ts";

const PLANTED = `(async () => {
  const busy = (ms) => { for (const end = performance.now() + ms; performance.now() < end; ); };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const yieldTask = () => new Promise((resolve) => { const ch = new MessageChannel(); ch.port1.onmessage = () => resolve(); ch.port2.postMessage(null); });
  const measure = async (fn) => (await __bench.measureMainThread(fn)).mainThread;
  const idle = await measure(() => sleep(300));
  const short = await measure(async () => {
    await sleep(150);
    busy(30);
    await sleep(150);
  });
  const long = await measure(async () => {
    await yieldTask();
    busy(200);
    await yieldTask();
    busy(20);
    await yieldTask();
    for (const end = performance.now() + 300; performance.now() < end; ) {
      busy(5);
      await yieldTask();
    }
  });
  return { idle, short, long };
})()`;

await buildBench({ quiet: true });
const server = await serve({ "/": path.join(BENCH_DIR, ".out"), "/data/": DATA_DIR });
const chrome = await launchChrome({ headless: true, onProgress: () => {} });
let seen: { idle: MainThread; short: MainThread; long: MainThread };
try {
  const tab = await chrome.openTab(`${server.origin}/index.html`);
  seen = await tab.evaluate<typeof seen>(PLANTED, 30_000);
} finally {
  await chrome.close();
  await server.close();
}

const { idle, short, long } = seen;
const within = (x: number, lo: number, hi: number) => x >= lo && x <= hi;
const failures = [
  !(idle.droppedFrames === 0 && within(idle.frameIntervalMs, 8, 34)) && "idle: want 0 dropped frames and a 8 to 34 ms frame interval",
  !(within(short.droppedFrames, 1, 2) && within(short.longestFrameMs, 30, 70) && short.longTasks === 0) &&
    "30 ms block: want 1 to 2 dropped frames, longest frame 30 to 70 ms, 0 long tasks",
  !(long.longTasks === 1 && within(long.longestMs, 200, 260) && within(long.blockedMs, 150, 210)) &&
    "200 ms block: want 1 long task, longest 200 to 260 ms, blocked 150 to 210 ms",
].filter(Boolean);
console.log(JSON.stringify(seen));
if (failures.length === 0) console.log("main-thread probe ok");
else {
  console.log(`main-thread probe FAILED: ${failures.join("; ")}`);
  process.exitCode = 1;
}
