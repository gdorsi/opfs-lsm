import type { Unsubscribe } from "../model/live.ts";

/** Awaited between the steps of a count. A recount no one waits on passes one that lets a frame paint. */
export type Pause = () => Promise<void>;

const yieldTask: Pause = () => new Promise((resolve) => setTimeout(resolve));

/**
 * Runs `count` now, and again after every change `subscribe` reports. One count runs at a time. Changes during a
 * count start one more, four times that count's duration after it and at least 250 ms, so a first sync, which
 * changes the issues every few milliseconds, spends at most a fifth of the main thread counting them. A count after a
 * change pauses between steps, so it does not hold up a frame, unless the page is `hidden`: a hidden page paints
 * nothing and wakes its timers about once a second. The first count does not pause, since the screen waits on it.
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
  const pauseUnlessHidden = () => (hidden() ? undefined : yieldTask);
  const run = async (pause?: Pause) => {
    timer = undefined;
    running = true;
    again = false;
    const t0 = performance.now();
    try {
      const value = await count(pause);
      if (live) emit(value);
    } catch (err) {
      console.warn("linearlite could not count issues", err);
    }
    running = false;
    if (live && again) timer = setTimeout(() => void run(pauseUnlessHidden()), Math.max(250, 4 * (performance.now() - t0)));
  };
  const off = subscribe(() => {
    if (running || timer !== undefined) again = true;
    else void run(pauseUnlessHidden());
  });
  void run();
  return () => {
    live = false;
    clearTimeout(timer);
    off();
  };
}
