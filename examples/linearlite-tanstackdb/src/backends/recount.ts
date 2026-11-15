import type { Unsubscribe } from "../model/live.ts";

/** Awaited between the steps of a count, so the page can paint and take input between them. */
export type Pause = () => Promise<void>;

/** One macrotask. A message is not clamped to 4 ms as a timer nested five deep is, so a count of many steps pays no clamp. */
const yieldTask: Pause = () =>
  new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(null);
  });

/** Thrown out of a pause once no one is subscribed, so a count whose value no one shows stops there. */
const STOPPED = new Error("no one is subscribed to this count");

/**
 * Runs `count` now, and again after every change `subscribe` reports. One count runs at a time. Changes during a
 * count start one more, four times that count's duration after it and at least 250 ms, so a first sync, which
 * changes the issues every few milliseconds, spends at most a fifth of the main thread counting them. Every count
 * pauses between steps, so it does not hold up a frame or a keystroke, unless the page is `hidden` and paints nothing.
 * Once unsubscribed, a count stops at its next pause.
 */
export function recount<T>(
  subscribe: (onChange: () => void) => Unsubscribe,
  count: (pause?: Pause) => Promise<T>,
  emit: (value: T) => void,
  hidden: () => boolean,
): Unsubscribe {
  let live = true;
  let running = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pauseWhileLive: Pause = async () => {
    await yieldTask();
    if (!live) throw STOPPED;
  };
  const pauseUnlessHidden = () => (hidden() ? undefined : pauseWhileLive);
  const run = async (pause?: Pause) => {
    timer = undefined;
    running = true;
    again = false;
    const t0 = performance.now();
    try {
      const value = await count(pause);
      if (live) emit(value);
    } catch (err) {
      if (err !== STOPPED) console.warn("linearlite could not count issues", err);
    }
    running = false;
    if (live && again) timer = setTimeout(() => void run(pauseUnlessHidden()), Math.max(250, 4 * (performance.now() - t0)));
  };
  const off = subscribe(() => {
    if (running || timer !== undefined) again = true;
    else void run(pauseUnlessHidden());
  });
  void run(pauseUnlessHidden());
  return () => {
    live = false;
    clearTimeout(timer);
    off();
  };
}
