import { serial } from "../turns.js";

let slot = serial();

/**
 * Run `merge` once every merge asked for before it has settled. A JS context
 * has one wasm engine with one merge session, and the working sets of two
 * merges would add up past the budget, so merges take turns whatever
 * database they belong to. A flush never waits here: it runs on the engine
 * between a merge's pumps.
 */
export function inMergeSlot<T>(merge: () => Promise<T>): Promise<T> {
  return slot(merge);
}

/**
 * A frozen host never settles its merge, and a process that died takes its
 * queue with it. A test that freezes a host to stand in for that death
 * clears the queue for the next host.
 */
export function __resetMergeSlotForTests(): void {
  slot = serial();
}
