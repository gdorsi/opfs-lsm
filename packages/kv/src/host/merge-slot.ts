let tail: Promise<unknown> = Promise.resolve();

/**
 * Run `merge` once every merge asked for before it has settled. A JS context
 * has one wasm engine with one merge session, and the working sets of two
 * merges would add up past the budget, so merges take turns whatever
 * database they belong to. A flush never waits here: it runs on the engine
 * between a merge's pumps.
 */
export function inMergeSlot<T>(merge: () => Promise<T>): Promise<T> {
  const run = tail.then(merge);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * A frozen host never settles its merge, and a process that died takes its
 * queue with it. A test that freezes a host to stand in for that death
 * clears the queue for the next host.
 */
export function __resetMergeSlotForTests(): void {
  tail = Promise.resolve();
}
