import "fake-indexeddb/auto";
import type { StorageAdapterInterface } from "@automerge/automerge-repo";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { kvStorage } from "@opfs-lsm/automerge";
import { newPageId } from "../src/model/bodies.ts";
import { openNotes } from "../src/model/notes.ts";
import type { Span, TextEdit } from "../src/model/types.ts";
import { memoryStorage } from "../src/storage/memory.ts";
import { random, randomBatch } from "../src/testing/random-edits.ts";
import { referenceBody } from "../src/testing/reference.ts";

const SEEDS = [1, 2, 3, 4, 5];
const EDITS = 3_000;
const CHECK_EVERY = 40;
const TAIL: TextEdit = { type: "insert", at: 1, text: "tail", marks: { italic: true } };

type Store = { open(): Promise<StorageAdapterInterface>; close(): Promise<void> };

function memoryStore(storage = memoryStorage()): Store {
  return { open: async () => storage, close: async () => {} };
}

function kvStore(): Store {
  const name = `notes${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  let close = async () => {};
  return {
    async open() {
      const db = await openHarnessDb({ name, forceMemory: true });
      close = () => db.close();
      return kvStorage(db);
    },
    close: () => close(),
  };
}

type Run = { edits: number; reopened: readonly Span[]; expected: readonly Span[] };

/** Random edits against the model and the oracle, checked live, then a reopen into a fresh Repo. */
async function fuzz(store: Store, seed: number, beforeTail = () => {}): Promise<Run> {
  const rand = random(seed);
  const oracle = referenceBody();
  const id = newPageId();
  const notes = await openNotes({ storage: await store.open() });
  const body = await notes.bodies.open(id);
  let edits = 0;
  for (let batches = 1; edits < EDITS; batches++) {
    const batch = randomBatch(rand, oracle);
    body.edit(batch);
    edits += batch.length;
    if (batches % CHECK_EVERY === 0) {
      assert.deepEqual(body.spans(), oracle.spans(), `seed ${seed}: live body after ${edits} edits`);
      await body.flush();
    }
  }
  beforeTail();
  body.edit([TAIL]);
  oracle.edit([TAIL]);
  await notes.close();
  await store.close();

  const again = await openNotes({ storage: await store.open() });
  const reopened = (await again.bodies.open(id)).spans();
  await again.close();
  await store.close();
  return { edits: edits + 1, reopened, expected: oracle.spans() };
}

for (const [name, store] of [
  ["memory", memoryStore],
  ["kv", kvStore],
] as const) {
  test(`fuzz on ${name}: ${SEEDS.length} seeds x ${EDITS} edits equal the oracle after a reopen`, async (t) => {
    for (const seed of SEEDS) {
      const started = performance.now();
      const run = await fuzz(store(), seed);
      assert.deepEqual(run.reopened, run.expected, `seed ${seed}: reopened body equals the oracle`);
      t.diagnostic(`${name} seed ${seed}: ${run.edits} edits matched in ${Math.round(performance.now() - started)} ms`);
    }
  });
}

test("a storage that drops one save fails the fuzz", async (t) => {
  const inner = memoryStorage();
  let armed = false;
  let dropped = 0;
  const lossy: StorageAdapterInterface = {
    ...inner,
    async save(key, data) {
      if (armed && key[1] !== "sync-state") {
        armed = false;
        dropped++;
        return;
      }
      await inner.save(key, data);
    },
  };
  const run = await fuzz(memoryStore(lossy), 1, () => (armed = true));
  assert.equal(dropped, 1);
  assert.notDeepEqual(run.reopened, run.expected, "the reopened body misses the dropped save");
  const text = (spans: readonly Span[]) => spans.map((span) => (span.type === "text" ? span.text : "¶")).join("");
  t.diagnostic(`expected starts ${JSON.stringify(text(run.expected).slice(0, 12))}, reopened starts ${JSON.stringify(text(run.reopened).slice(0, 12))}`);
});
