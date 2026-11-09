/**
 * Debounce the latest document, then save it.
 *
 * `flush` starts that save immediately and returns true while a save is still
 * running. Callers use the flag to avoid closing the database: close can cut
 * off the log write the save just started.
 */
export type DebouncedSave<T> = {
  push(doc: T): void;
  flush(): boolean;
  hasPending(): boolean;
  /** True while a document is waiting or a save has not settled. */
  busy(): boolean;
};

type Timer = {
  schedule(fn: () => void, delayMs: number): number;
  cancel(id: number): void;
};

const domTimer: Timer = {
  schedule: (fn, delayMs) => window.setTimeout(fn, delayMs),
  cancel: (id) => window.clearTimeout(id),
};

export function createDebouncedSave<T>(opts: {
  delayMs: number;
  save: (doc: T) => Promise<void>;
  onError?: (err: unknown) => void;
  timer?: Timer;
}): DebouncedSave<T> {
  const timer = opts.timer ?? domTimer;
  let pending: { doc: T } | undefined;
  let timerId: number | undefined;
  let writes = 0;

  function flush(): boolean {
    const next = pending;
    pending = undefined;
    if (timerId !== undefined) {
      timer.cancel(timerId);
      timerId = undefined;
    }
    if (next) {
      writes += 1;
      let pendingSave: Promise<void>;
      try {
        // Call save synchronously so a beforeunload flush starts its
        // log write before the page freezes.
        pendingSave = opts.save(next.doc);
      } catch (err) {
        writes -= 1;
        opts.onError?.(err);
        return writes > 0;
      }
      void Promise.resolve(pendingSave).then(
        () => {
          writes -= 1;
        },
        (err) => {
          writes -= 1;
          opts.onError?.(err);
        },
      );
    }
    return writes > 0;
  }

  return {
    push(doc) {
      pending = { doc };
      if (timerId !== undefined) timer.cancel(timerId);
      timerId = timer.schedule(() => {
        timerId = undefined;
        flush();
      }, opts.delayMs);
    },
    flush,
    hasPending: () => pending !== undefined,
    busy: () => pending !== undefined || writes > 0,
  };
}
