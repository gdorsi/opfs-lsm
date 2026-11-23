import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { clientRoot, createClient, view } from "@nkzw/fate";
import { createPersistence, type PersistenceStorage } from "@nkzw/fate/persistence";
import { ConstraintError, type Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { kvStorage } from "../src/index.ts";

function dbName(): string {
  return `fate${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

async function withDb(body: (db: Db, storage: PersistenceStorage) => Promise<void>): Promise<void> {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  try {
    await body(db, kvStorage(db));
  } finally {
    await db.close();
  }
}

test("a batch over 8 MiB rejects ConstraintError and writes nothing", () =>
  withDb(async (_db, storage) => {
    const half = "x".repeat(4.5 * 2 ** 20);
    await assert.rejects(
      storage.writeBatch([
        ["a", half],
        ["b", half],
      ]),
      ConstraintError,
    );
    assert.equal(await storage.read("a"), undefined);
    assert.equal(await storage.read("b"), undefined);
  }));

test("exclusive without Web Locks rejects", () =>
  withDb(async (_db, storage) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator")!;
    Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
    try {
      await assert.rejects(storage.exclusive("x", async () => 1), /Web Locks/);
    } finally {
      Object.defineProperty(globalThis, "navigator", descriptor);
    }
  }));

type Post = { __typename: "Post"; id: string; title: string };
const PostView = view<Post>()({ id: true, title: true });
const page = {
  posts: {
    list: {
      items: { cursor: true, node: PostView },
      pagination: { hasNext: true, hasPrevious: true },
    },
  },
};

test("a fate write over the size limit surfaces as a persistence error", () =>
  withDb(async (_db, storage) => {
    const posts: Post[] = Array.from({ length: 12 }, (_, i) => ({ __typename: "Post", id: String(i + 1), title: "x".repeat(800_000) }));
    const roots = { posts: clientRoot("Post") };
    const client = createClient<[typeof roots, Record<never, never>]>({
      persistence: createPersistence({ key: "big", online: () => false, storage }),
      roots,
      transport: {
        fetchById: async () => posts,
        fetchList: async () => ({
          items: posts.map((node) => ({ cursor: `c${node.id}`, node })),
          pagination: { hasNext: false, hasPrevious: false },
        }),
      } as never,
      types: [{ fields: { title: "scalar" }, type: "Post" }],
    });
    try {
      await client.request(page, { mode: "network-only" });
      const flushed = await client.persistence!.flush().then(
        () => undefined,
        (error: unknown) => error,
      );
      const error = flushed ?? client.persistence!.getSnapshot().error;
      assert.ok(error instanceof ConstraintError, `expected ConstraintError, got ${String(error)}`);
    } finally {
      client.persistence!.dispose();
    }
  }));
