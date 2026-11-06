import assert from "node:assert/strict";
import test from "node:test";
import { createDebouncedSave } from "./src/debounced-save.ts";

function fakeTimer() {
  let next = 1;
  const jobs = new Map<number, { fn: () => void; delayMs: number }>();
  return {
    jobs,
    schedule(fn: () => void, delayMs: number) {
      const id = next++;
      jobs.set(id, { fn, delayMs });
      return id;
    },
    cancel(id: number) {
      jobs.delete(id);
    },
    fire() {
      const id = jobs.keys().next().value as number | undefined;
      if (id === undefined) throw new Error("no timer");
      const job = jobs.get(id)!;
      jobs.delete(id);
      job.fn();
      return job.delayMs;
    },
  };
}

async function drain(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("the timer saves only the latest document", async () => {
  const timer = fakeTimer();
  const saved: string[] = [];
  let quiet = 0;
  const queue = createDebouncedSave({
    delayMs: 300,
    timer,
    save: async (doc: string) => {
      saved.push(doc);
      quiet += 1;
    },
  });

  queue.push("a");
  queue.push("b");
  assert.equal(queue.hasPending(), true);
  assert.equal(queue.busy(), true);
  assert.equal(timer.jobs.size, 1);

  const delayMs = timer.fire();
  assert.equal(delayMs, 300);
  assert.deepEqual(saved, ["b"]);
  assert.equal(queue.hasPending(), false);
  assert.equal(queue.flush(), true);
  await drain();
  assert.equal(quiet, 1);
  assert.equal(queue.busy(), false);
  assert.equal(queue.flush(), false);
});

test("flush starts the pending save immediately and stays busy until it finishes", async () => {
  const timer = fakeTimer();
  const saved: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue = createDebouncedSave({
    delayMs: 300,
    timer,
    save: (doc: string) => {
      saved.push(doc);
      return gate;
    },
  });

  queue.push("v1");
  queue.push("v2");
  assert.equal(queue.flush(), true);
  assert.equal(queue.busy(), true);
  assert.equal(timer.jobs.size, 0);
  assert.deepEqual(saved, ["v2"]);
  assert.equal(queue.hasPending(), false);
  assert.equal(queue.flush(), true);

  release();
  await gate;
  await drain();
  assert.equal(queue.flush(), false);
});

test("a second flush while a save is running writes the newer document", async () => {
  const timer = fakeTimer();
  const saved: string[] = [];
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;
  const queue = createDebouncedSave({
    delayMs: 300,
    timer,
    save: (doc: string) => {
      saved.push(doc);
      calls += 1;
      return calls === 1 ? first : Promise.resolve();
    },
  });

  queue.push("a");
  assert.equal(queue.flush(), true);
  queue.push("b");
  assert.equal(queue.flush(), true);
  assert.deepEqual(saved, ["a", "b"]);

  await drain();
  assert.equal(queue.flush(), true);
  releaseFirst();
  await first;
  await drain();
  assert.equal(queue.flush(), false);
});

test("a rejected save is reported and does not stick in flight", async () => {
  const errors: unknown[] = [];
  const queue = createDebouncedSave({
    delayMs: 300,
    timer: fakeTimer(),
    save: async () => {
      throw new Error("disk");
    },
    onError: (err) => errors.push(err),
  });

  queue.push("a");
  assert.equal(queue.flush(), true);
  await drain();
  assert.equal(errors.length, 1);
  assert.equal(queue.flush(), false);
});

test("a synchronous save throw is reported and does not stick in flight", () => {
  const errors: unknown[] = [];
  const queue = createDebouncedSave({
    delayMs: 300,
    timer: fakeTimer(),
    save: () => {
      throw new Error("sync");
    },
    onError: (err) => errors.push(err),
  });

  queue.push("a");
  assert.equal(queue.flush(), false);
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof Error);
});
