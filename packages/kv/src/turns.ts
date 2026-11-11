/**
 * A queue of one: each call runs once every call before it has settled,
 * whether it resolved or rejected.
 */
export function serial(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/**
 * One `pass` at a time. A call during a pass asks for one more after it and
 * gets the promise of the passes in flight, so any number of calls made
 * during a pass cost one more pass. A pass that throws ends the run.
 */
export function coalesced(pass: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await pass();
        } while (again);
      } finally {
        running = undefined;
      }
    })();
    return running;
  };
}
