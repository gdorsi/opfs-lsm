import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createClient, clientRoot, view } from "@nkzw/fate";
import { createPersistence, type PersistenceStorage } from "@nkzw/fate/persistence";
import { ConstraintError, type Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { kvStorage } from "../src/index.ts";

function dbName(): string {
  return `fate${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withDb(body: (db: Db, storage: PersistenceStorage) => Promise<void>): Promise<void> {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  try {
    await body(db, kvStorage(db));
  } finally {
    await db.close();
  }
}

const put = (storage: PersistenceStorage, ...keys: string[]) =>
  storage.writeBatch(keys.map((key) => [key, { key }] as const));

const keysOf = async (storage: PersistenceStorage, prefix: string, after?: string, limit?: number) =>
  (await storage.scan(prefix, after, limit)).map((entry) => entry.key);

test("values round-trip, a missing key reads undefined, reads return distinct objects", () =>
  withDb(async (_db, storage) => {
    const value = { a: [1, 2, { b: null }], s: "x", n: 1.5, t: true };
    await storage.writeBatch([["k", value]]);
    assert.deepEqual(await storage.read("k"), value);
    assert.equal(await storage.read("missing"), undefined);

    const first = (await storage.read("k")) as typeof value;
    first.a.push(3);
    first.s = "changed";
    assert.deepEqual(await storage.read("k"), value);
    assert.notEqual(await storage.read("k"), await storage.read("k"));
  }));

test("writeBatch applies puts and deletes together", () =>
  withDb(async (_db, storage) => {
    await storage.writeBatch([
      ["a", 1],
      ["b", 2],
    ]);
    await storage.writeBatch([
      ["a", undefined],
      ["b", 3],
      ["c", 4],
      ["absent", undefined],
    ]);
    assert.equal(await storage.read("a"), undefined);
    assert.equal(await storage.read("b"), 3);
    assert.equal(await storage.read("c"), 4);
    await storage.writeBatch([]);
    assert.deepEqual(await keysOf(storage, ""), ["b", "c"]);
  }));

test("writeBatch is one atomic write: a bad key or an oversized batch writes nothing", () =>
  withDb(async (_db, storage) => {
    await assert.rejects(
      storage.writeBatch([
        ["ok", 1],
        ["\ud800", 2],
      ]),
      /lone surrogate/,
    );
    await assert.rejects(
      storage.writeBatch([
        ["ok", 1],
        ["x".repeat(9000), 2],
      ]),
      ConstraintError,
    );
    assert.equal(await storage.read("ok"), undefined);
  }));

test("scan returns the entries under a prefix in ascending order and excludes sibling prefixes", () =>
  withDb(async (_db, storage) => {
    await put(storage, "a:2", "a:1", "a:", "a;1", "a9", "b:1", "a:10");
    assert.deepEqual(await keysOf(storage, "a:"), ["a:", "a:1", "a:10", "a:2"]);
    assert.deepEqual(await storage.scan("a:1"), [
      { key: "a:1", value: { key: "a:1" } },
      { key: "a:10", value: { key: "a:10" } },
    ]);
    assert.deepEqual(await keysOf(storage, "none:"), []);
  }));

test("scan with a prefix ending in the highest code unit stays inside the prefix", () =>
  withDb(async (_db, storage) => {
    await put(storage, "a\uffff", "a\uffff1", "a\uffff\uffff", "b", "a");
    assert.deepEqual(await keysOf(storage, "a\uffff"), ["a\uffff", "a\uffff1", "a\uffff\uffff"]);
    assert.deepEqual(await keysOf(storage, "\uffff"), []);
  }));

test("scan treats after as exclusive and pages with the last key", () =>
  withDb(async (_db, storage) => {
    const all = Array.from({ length: 10 }, (_, i) => `p:${i}`);
    await put(storage, ...all, "q:0");
    assert.deepEqual(await keysOf(storage, "p:", "p:3"), all.slice(4));
    assert.deepEqual(await keysOf(storage, "p:", "p:9"), []);
    assert.deepEqual(await keysOf(storage, "p:", "p:99"), []);
    assert.deepEqual(await keysOf(storage, "p:", "q:"), []);

    const paged: string[] = [];
    for (let after: string | undefined; ; ) {
      const page = await keysOf(storage, "p:", after, 4);
      assert.ok(page.length <= 4);
      if (page.length === 0) break;
      paged.push(...page);
      after = page.at(-1);
    }
    assert.deepEqual(paged, all);
  }));

test("scan starts at the prefix when after sorts before it", () =>
  withDb(async (_db, storage) => {
    await put(storage, "a:1", "m:1", "m:2");
    assert.deepEqual(await keysOf(storage, "m:", "a:9"), ["m:1", "m:2"]);
    assert.deepEqual(await keysOf(storage, "m:", ""), ["m:1", "m:2"]);
    assert.deepEqual(await keysOf(storage, "m:", "m"), ["m:1", "m:2"]);
  }));

test("scan limit: default, fractional, zero, negative and NaN", () =>
  withDb(async (_db, storage) => {
    const all = Array.from({ length: 100 }, (_, i) => `k${String(i).padStart(3, "0")}`);
    await put(storage, ...all);
    assert.equal((await storage.scan("k")).length, 64);
    assert.deepEqual(await keysOf(storage, "k", undefined, 2.5), all.slice(0, 3));
    assert.equal((await storage.scan("k", undefined, Infinity)).length, 100);
    for (const limit of [0, -1, Number.NaN]) assert.deepEqual(await storage.scan("k", undefined, limit), []);
  }));

test("scan no longer returns a deleted key", () =>
  withDb(async (_db, storage) => {
    await put(storage, "d:1", "d:2", "d:3");
    await storage.writeBatch([["d:2", undefined]]);
    assert.deepEqual(await keysOf(storage, "d:"), ["d:1", "d:3"]);
    assert.deepEqual(await keysOf(storage, "d:", "d:1"), ["d:3"]);
  }));

test("scan returns 16-digit zero-padded stamps in numeric order", () =>
  withDb(async (_db, storage) => {
    const stamp = (n: number) => `journal:${String(n).padStart(16, "0")}`;
    const numbers = [10, 9, 100, 1, 99_999, 2, 1_000_000_000_000, 11];
    await put(storage, ...numbers.map(stamp));
    assert.deepEqual(
      await keysOf(storage, "journal:"),
      [...numbers].sort((a, b) => a - b).map(stamp),
    );
  }));

test("keys with quotes, backslashes, non-ASCII and astral characters come back exactly", () =>
  withDb(async (_db, storage) => {
    const keys = ['x:"q"', "x:back\\slash", "x:caf\u00e9", "x:\u65e5\u672c", "x:\u{1f600}", "x:\u0000nul", "x:a b\n"];
    await put(storage, ...keys);
    assert.deepEqual((await keysOf(storage, "x:")).sort(), [...keys].sort());
    for (const key of keys) assert.deepEqual(await storage.read(key), { key });
  }));

test("a key with a lone surrogate is rejected everywhere", () =>
  withDb(async (_db, storage) => {
    for (const key of ["\ud800", "a\udc00", "\udc00\ud800", "x\ud83d"]) {
      await assert.rejects(storage.read(key), /lone surrogate/);
      await assert.rejects(storage.writeBatch([[key, 1]]), /lone surrogate/);
      await assert.rejects(storage.scan(key), /lone surrogate/);
      await assert.rejects(storage.scan("a", key), /lone surrogate/);
      assert.throws(() => storage.subscribe!(key, () => {}), /lone surrogate/);
    }
    await put(storage, "\u{1f600}");
    assert.deepEqual(await keysOf(storage, ""), ["\u{1f600}"]);
  }));

test("exclusive sections with one name never overlap", () =>
  withDb(async (_db, storage) => {
    const events: string[] = [];
    const section = (id: number) =>
      storage.exclusive("same", async () => {
        events.push(`in${id}`);
        await sleep(10);
        events.push(`out${id}`);
      });
    await Promise.all([section(1), section(2), section(3)]);
    assert.deepEqual(events, ["in1", "out1", "in2", "out2", "in3", "out3"]);
  }));

test("exclusive sections with different names nest and run apart", () =>
  withDb(async (_db, storage) => {
    const nested = await storage.exclusive("delivery", () => storage.exclusive("write", async () => "inner"));
    assert.equal(nested, "inner");

    const events: string[] = [];
    const section = (name: string) =>
      storage.exclusive(name, async () => {
        events.push(`in:${name}`);
        await sleep(10);
        events.push(`out:${name}`);
      });
    await Promise.all([section("a"), section("b")]);
    assert.deepEqual(events.slice(0, 2).sort(), ["in:a", "in:b"]);
  }));

test("exclusive passes the result through and releases the lock when run rejects", { timeout: 5000 }, () =>
  withDb(async (_db, storage) => {
    assert.deepEqual(await storage.exclusive("r", async () => ({ ok: 1 })), { ok: 1 });
    await assert.rejects(
      storage.exclusive("r", async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(await storage.exclusive("r", async () => "again"), "again");
  }));

test("exclusive takes names longer than a lock name limit, in call order", () =>
  withDb(async (_db, storage) => {
    const name = "n".repeat(5000);
    const ids = Array.from({ length: 64 }, (_, i) => i);
    for (let round = 0; round < 20; round++) {
      const order: number[] = [];
      const results = await Promise.all(
        ids.map((id) =>
          storage.exclusive(name, async () => {
            order.push(id);
            return id;
          }),
        ),
      );
      assert.deepEqual(results, ids);
      assert.deepEqual(order, ids);
    }
  }));

type Tabs = { a: Db; b: Db; sa: PersistenceStorage; sb: PersistenceStorage };

/** Two handles on one database, the way two tabs open it. `b` gets no BroadcastChannel, so only `sync()` brings it A's writes. */
async function withTabs(body: (tabs: Tabs) => Promise<void>, busForB = false): Promise<void> {
  const name = dbName();
  const a = await openHarnessDb({ name, forceMemory: true, writerId: "tab-a" });
  const g = globalThis as { BroadcastChannel?: unknown };
  const real = g.BroadcastChannel;
  if (!busForB) g.BroadcastChannel = undefined;
  let b: Db;
  try {
    b = await openHarnessDb({ name, forceMemory: true, writerId: "tab-b" });
  } finally {
    g.BroadcastChannel = real;
  }
  try {
    await body({ a, b, sa: kvStorage(a), sb: kvStorage(b) });
  } finally {
    await a.close();
    await b.close();
  }
}

test("a write through one handle is visible to read and scan inside the other handle's exclusive", () =>
  withTabs(async ({ sa, sb }) => {
    await sa.writeBatch([
      ["tab:1", { n: 1 }],
      ["tab:2", { n: 2 }],
    ]);
    assert.equal(await sb.read("tab:1"), undefined, "without a lock grant handle B has not caught up");

    await sb.exclusive("lock", async () => {
      assert.deepEqual(await sb.read("tab:1"), { n: 1 });
      assert.deepEqual(await keysOf(sb, "tab:"), ["tab:1", "tab:2"]);
    });

    await sa.writeBatch([["tab:1", undefined]]);
    await sb.exclusive("lock", async () => {
      assert.equal(await sb.read("tab:1"), undefined);
      assert.deepEqual(await keysOf(sb, "tab:"), ["tab:2"]);
    });
  }));

test("subscribe fires for another handle's write to that key and stops after unsubscribe", () =>
  withTabs(async ({ sa, sb }) => {
    let fired = 0;
    const unsubscribe = sb.subscribe!("watched", () => fired++);

    await sa.writeBatch([["other", 1]]);
    await sa.writeBatch([["watched", 1]]);
    await sb.exclusive("lock", async () => {});
    assert.equal(fired, 1);

    await sa.writeBatch([["watched", undefined]]);
    await sb.exclusive("lock", async () => {});
    assert.equal(fired, 2, "a delete of the key fires too");

    unsubscribe();
    await sa.writeBatch([["watched", 2]]);
    await sb.exclusive("lock", async () => {});
    assert.equal(fired, 2);
  }));

test("subscribe fires on the handle's own write", () =>
  withDb(async (_db, storage) => {
    let fired = 0;
    const unsubscribe = storage.subscribe!("mine", () => fired++);
    await storage.writeBatch([["mine", 1]]);
    unsubscribe();
    assert.equal(fired, 1);
  }));

test("subscribe fires for a range delete over the key, and not for one beside it", () =>
  withDb(async (db, storage) => {
    let fired = 0;
    storage.subscribe!("mine", () => fired++);
    await storage.writeBatch([["mine", 1]]);
    await db.batch((tx) => tx.deleteRange({ start: new Uint8Array([0xff]) }));
    assert.equal(fired, 1);
    await db.batch((tx) => tx.deleteRange({}));
    assert.equal(fired, 2);
  }));

test("subscribe fires when the database is destroyed from another handle", () =>
  withTabs(async ({ a, sa, sb }) => {
    await sa.writeBatch([["watched", 1]]);
    await sb.exclusive("lock", async () => {});
    let fired = 0;
    sb.subscribe!("watched", () => fired++);
    await a.dangerousDestroy();
    await sb.exclusive("lock", async () => {});
    assert.ok(fired >= 1);
    assert.equal(await sb.read("watched"), undefined);
  }));

type Post = { __typename: "Post"; id: string; title: string; likes: number };
const PostView = view<Post>()({ id: true, title: true, likes: true });
const page = {
  posts: {
    list: {
      items: { cursor: true, node: PostView },
      pagination: { hasNext: true, hasPrevious: true },
    },
  },
};

function makeClient(storage: PersistenceStorage, transport: Record<string, unknown>) {
  const roots = { posts: clientRoot("Post") };
  return createClient<[typeof roots, Record<never, never>]>({
    persistence: createPersistence({ key: "e2e", online: () => false, storage }),
    roots,
    transport: transport as never,
    types: [{ fields: { title: "scalar", likes: "scalar" }, type: "Post" }],
  });
}

test("a fate client persists a list through kv and restores it in a new client with no transport call", () =>
  withDb(async (db) => {
    const outside: string[] = [];
    let depth = 0;
    const real = kvStorage(db);
    const storage: PersistenceStorage = {
      ...real,
      exclusive: (name, run) =>
        real.exclusive(name, async () => {
          depth++;
          try {
            return await run();
          } finally {
            depth--;
          }
        }),
      read: (key) => (depth > 0 || outside.push(`read ${key}`), real.read(key)),
      scan: (prefix, after, limit) => (depth > 0 || outside.push(`scan ${prefix}`), real.scan(prefix, after, limit)),
    };

    const posts: Post[] = Array.from({ length: 40 }, (_, i) => ({
      __typename: "Post",
      id: String(i + 1),
      title: `Post \u201c${i + 1}\u201d \u{1f600}`,
      likes: i * 3,
    }));
    const first = makeClient(storage, {
      fetchById: async () => posts,
      fetchList: async () => ({
        items: posts.map((node) => ({ cursor: `c${node.id}`, node })),
        pagination: { hasNext: false, hasPrevious: false },
      }),
    });
    await first.request(page, { mode: "network-only" });
    await first.persistence!.flush();
    first.persistence!.dispose();

    const refuse = async () => {
      throw new Error("transport must not be called");
    };
    const second = makeClient(storage, { fetchById: refuse, fetchList: refuse });
    try {
      await second.request(page);
      for (const post of posts) assert.deepEqual(second.store.read(`Post:${post.id}`), post);
      assert.deepEqual(
        second.store.dehydrate().lists[0]![1].ids,
        posts.map((post) => `Post:${post.id}`),
      );
      assert.deepEqual(outside, [], "fate reads storage only inside exclusive sections");
    } finally {
      second.persistence!.dispose();
    }
  }));
