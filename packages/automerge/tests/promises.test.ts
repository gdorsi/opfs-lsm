import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Repo, type AutomergeUrl } from "@automerge/automerge-repo";
import { ConstraintError } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { kvStorage } from "../src/index.ts";

function dbName(): string {
  return `am${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

type Doc = { items: string[]; count?: number };

async function openRepo(name: string, writerId?: string) {
  const db = await openHarnessDb({ name, forceMemory: true, ...(writerId ? { writerId } : {}) });
  return { db, repo: new Repo({ storage: kvStorage(db), network: [] }) };
}

test("a document reloads in a new repo with the same heads and content", async () => {
  const name = dbName();
  const first = await openRepo(name);
  const handle = first.repo.create<Doc>({ items: [] });
  for (let i = 0; i < 50; i++) handle.change((d) => void d.items.push(`item ${i}`));
  const heads = handle.heads();
  const url = handle.url;
  await first.repo.flush();
  await first.repo.shutdown();

  const second = await openRepo(name);
  try {
    const again = await second.repo.find<Doc>(url);
    assert.deepEqual(again.heads(), heads);
    assert.deepEqual(again.doc().items, Array.from({ length: 50 }, (_, i) => `item ${i}`));
  } finally {
    await second.repo.shutdown();
  }
});

test("two tabs saving changes to one document both survive a reload", async () => {
  const name = dbName();
  const seed = await openRepo(name);
  const url: AutomergeUrl = seed.repo.create<Doc>({ items: [] }).url;
  await seed.repo.flush();
  await seed.repo.shutdown();

  const a = await openRepo(name, "tab-a");
  const b = await openRepo(name, "tab-b");
  const ha = await a.repo.find<Doc>(url);
  const hb = await b.repo.find<Doc>(url);
  for (let i = 0; i < 30; i++) {
    ha.change((d) => void d.items.push(`a${i}`));
    hb.change((d) => void d.items.push(`b${i}`));
    if (i % 7 === 0) await Promise.all([a.repo.flush(), b.repo.flush()]);
  }
  await Promise.all([a.repo.flush(), b.repo.flush()]);
  await Promise.all([a.repo.shutdown(), b.repo.shutdown()]);

  const fresh = await openRepo(name);
  try {
    const items = (await fresh.repo.find<Doc>(url)).doc().items;
    assert.equal(items.length, 60);
    assert.deepEqual(new Set(items), new Set([...Array.from({ length: 30 }, (_, i) => `a${i}`), ...Array.from({ length: 30 }, (_, i) => `b${i}`)]));
  } finally {
    await fresh.repo.shutdown();
  }
});

test("a chunk over 8 MiB rejects ConstraintError", async () => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  const storage = kvStorage(db);
  try {
    await assert.rejects(storage.save(["big"], new Uint8Array((8 << 20) + 1)), ConstraintError);
    assert.equal(await storage.load(["big"]), undefined);
  } finally {
    await storage.close?.();
  }
});
