import { ingest } from "@opfs-lsm/kv/testing";
import { ClosedError, type ChangeOp, type Db } from "@opfs-lsm/kv";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collection, defineSchema, openDocStore, type CollectionChange, type DocStoreError } from "../src/index.js";
import { encodeCatalog } from "../src/catalog.js";
import { CATALOG_KEY, concat, rowPrefix, utf8, type CollectionId } from "../src/keys.js";
import { schema, type Doc, type Docs } from "./docs.js";
import { freshName, openKv, openKvWithoutBus, storedCatalog, storedPrefix, wrap } from "./harness.js";

const open: Db[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((kv) => kv.close()));
  vi.restoreAllMocks();
});

async function handle(name = freshName(), connect = openKv) {
  const kv = await connect(name);
  open.push(kv);
  const store = await openDocStore(kv, schema);
  return { kv, store, c: store.collection("docs") };
}

/** What a listener saw, with each change reduced to what it reports without parsing. */
function listen(c: Docs) {
  const events: CollectionChange<Doc>[] = [];
  const stop = c.changes((e) => events.push(e));
  return { events, stop };
}

const summary = (events: readonly CollectionChange<Doc>[]) =>
  events.map((e) =>
    e.kind === "append" ? e.changes.map((ch) => (ch.deleted ? `-${ch.id}` : `+${ch.id}`)).join(" ") : e.kind,
  );

const settled = (check: () => void) => vi.waitFor(check, { timeout: 2_000, interval: 5 });

describe("changes", () => {
  it("reports each write as one append with the ids, the stored documents and the kv seq, in order", async () => {
    const { kv, c } = await handle();
    const { events } = listen(c);
    await c.put({ id: "1", a: -0, b: undefined });
    await c.putMany([{ id: "2", a: 2 }, { id: "3", a: 3 }]);
    await c.modify("2", (d) => ({ ...d, a: 20 }));
    await c.deleteMany(["1", "3"]);
    await settled(() => expect(events).toHaveLength(4));

    expect(summary(events)).toEqual(["+1", "+2 +3", "+2", "-1 -3"]);
    const docs = events.flatMap((e) => (e.kind === "append" ? e.changes.map((ch) => ch.doc) : []));
    expect(docs).toEqual([{ id: "1", a: 0 }, { id: "2", a: 2 }, { id: "3", a: 3 }, { id: "2", a: 20 }, undefined, undefined]);
    const seqs = events.map((e) => (e.kind === "append" ? e.seq : -1));
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(4);
    expect(seqs.at(-1)).toBe(await kv.view((snap) => snap.seq));
  });

  it("keeps id, deleted and doc in a copy of a change, as postMessage or JSON makes one", async () => {
    const { c } = await handle();
    const { events } = listen(c);
    await c.put({ id: "1", a: 1 });
    await c.delete("1");
    await settled(() => expect(events).toHaveLength(2));
    const changes = events.flatMap((e) => (e.kind === "append" ? e.changes : []));
    const want = [{ id: "1", deleted: false, doc: { id: "1", a: 1 } }, { id: "1", deleted: true, doc: undefined }];
    expect(changes.map((ch) => structuredClone({ ...ch }))).toEqual(want);
    expect(JSON.parse(JSON.stringify(changes[0]))).toEqual(want[0]);
  });

  it("reports a write of its own handle before the write resolves, once the listener has started", async () => {
    const { c } = await handle();
    const { events } = listen(c);
    await c.put({ id: "start", a: 0 });
    await settled(() => expect(events).toHaveLength(1));
    const counts: number[] = [];
    await c.put({ id: "a", a: 1 });
    counts.push(events.length);
    await c.modifyMany(["a", "b"], () => [{ id: "a", a: 2 }, { id: "b", a: 3 }]);
    counts.push(events.length);
    await c.deleteMany(["a", "b"]);
    counts.push(events.length);
    expect(counts).toEqual([2, 3, 4]);
  });

  it("lets a listener that reads only ids and deleted skip the parse of a document it cannot parse", async () => {
    const { kv, c } = await handle();
    const { events } = listen(c);
    const rows = concat(await storedPrefix(kv, "docs"), Uint8Array.of(0));
    await kv.put(concat(rows, new TextEncoder().encode("broken")), new TextEncoder().encode("{not json"));
    await c.put({ id: "fine", a: 1 });
    await settled(() => expect(events).toHaveLength(2));

    const [broken, fine] = events.flatMap((e) => (e.kind === "append" ? e.changes : []));
    expect({ id: broken!.id, deleted: broken!.deleted }).toEqual({ id: "broken", deleted: false });
    expect(() => broken!.doc).toThrow(SyntaxError);
    expect(fine!.doc).toEqual({ id: "fine", a: 1 });
  });

  it("sends a gap for a kv range delete over the collection's rows, and nothing for one elsewhere", async () => {
    const { kv, c } = await handle();
    await c.put({ id: "1", a: 1 });
    const { events } = listen(c);
    const rows = concat(await storedPrefix(kv, "docs"), Uint8Array.of(0));
    await kv.batch((tx) => tx.deleteRange({ start: Uint8Array.of(0xf0) }));
    await c.put({ id: "2", a: 2 });
    await kv.batch((tx) => tx.deleteRange({ start: rows }));
    await c.put({ id: "3", a: 3 });
    await kv.batch((tx) => tx.deleteRange({ start: concat(rows, utf8.encode("3")), endExclusive: concat(rows, utf8.encode("4")) }));
    await c.put({ id: "4", a: 4 });
    await settled(() => expect(summary(events)).toEqual(["+2", "gap", "+3", "gap", "+4"]));
    expect(await c.getMany(["1", "3"])).toEqual([undefined, undefined]);
  });

  it("ignores the entries of the indexes and the other collections", async () => {
    type Other = { id: string; x?: number };
    const two = defineSchema({
      version: 1,
      collections: { docs: collection<Doc>().index("one", "a").index("tags", "tags[]"), other: collection<Other>().index("byX", "x") },
    });
    const kv = await openKv(freshName());
    open.push(kv);
    const store = await openDocStore(kv, two);
    const docs = store.collection("docs");
    const events: CollectionChange<Doc>[] = [];
    docs.changes((e) => events.push(e));
    await store.collection("other").putMany([{ id: "o1", x: 1 }, { id: "o2", x: 2 }]);
    await docs.putMany([{ id: "d1", a: 1, tags: ["p", "q", "r"] }, { id: "d2", a: 2, tags: ["p"] }]);
    await store.collection("other").delete("o1");
    await settled(() => expect(events).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(summary(events)).toEqual(["+d1 +d2"]);
  });

  it("reports the writes of other handles, once they reach this one", async () => {
    const name = freshName();
    const a = await handle(name);
    const b = await handle(name);
    const { events } = listen(a.c);
    await b.c.putMany([{ id: "x", a: 1 }, { id: "y", a: 2 }]);
    await b.c.delete("x");
    await a.kv.sync();
    await settled(() => expect(summary(events)).toEqual(["+x +y", "-x"]));
  });

  it("reports the writes of a handle that learns of them only through sync", async () => {
    const name = freshName();
    const writer = await handle(name);
    const reader = await handle(name, openKvWithoutBus);
    const { events } = listen(reader.c);
    await writer.c.put({ id: "x", a: 1 });
    await reader.kv.sync();
    await settled(() => expect(summary(events)).toEqual(["+x"]));
  });

  it("gives the documents of one write, puts and deletes mixed, past 64 KiB and not ASCII", async () => {
    const { c } = await handle();
    const ids = Array.from({ length: 800 }, (_, i) => `d${i}`);
    await c.putMany(ids.map((id) => ({ id, a: 0 })));
    const { events } = listen(c);
    const next = (id: string, i: number) => (i % 3 === 0 ? null : { id, a: i, t: `ünï ${"x".repeat(100)} \ud800 ${i}` });
    await c.modifyMany(ids, () => ids.map(next));
    await settled(() => expect(events).toHaveLength(1));
    const [event] = events;
    expect(event!.kind === "append" && event!.changes.map((ch) => ch.doc)).toEqual(ids.map((id, i) => next(id, i) ?? undefined));
  });

  it("gives each document of a kv record that a catalog change splits in two events, read as each arrives", async () => {
    const { kv, c } = await handle();
    await c.put({ id: "seed", a: 0 });
    const catalog = await storedCatalog(kv);
    const from = catalog.collections["docs"]!;
    const to = catalog.nextCollectionId;
    const seen: unknown[] = [];
    c.changes((e) => e.kind === "append" && seen.push(...e.changes.map((ch) => ch.doc)));
    const row = (id: number, doc: Doc) => [concat(rowPrefix(id as CollectionId), utf8.encode(doc.id)), utf8.encode(JSON.stringify(doc))] as const;
    await kv.batch((tx) => {
      tx.put(...row(from.id, { id: "before", a: 1 }));
      tx.put(CATALOG_KEY, encodeCatalog({ ...catalog, nextCollectionId: to + 1, collections: { docs: { ...from, id: to } } }));
      tx.put(...row(to, { id: "after", a: 2 }));
    });
    await settled(() => expect(seen).toEqual([{ id: "before", a: 1 }, { id: "after", a: 2 }]));
  });

  it("sends one gap for clear(), then reports the writes made after it", async () => {
    const { store, c } = await handle();
    await c.putMany([{ id: "old1", a: 1 }, { id: "old2", a: 2 }]);
    const { events } = listen(c);
    await c.clear();
    await c.put({ id: "new", a: 3 });
    await store.whenIdle();
    await settled(() => expect(summary(events)).toEqual(["gap", "+new"]));
    await c.put({ id: "later", a: 4 });
    await settled(() => expect(summary(events)).toEqual(["gap", "+new", "+later"]));
  });

  it("follows a clear made by another handle, and one this handle had not read before it subscribed", async () => {
    const name = freshName();
    const a = await handle(name);
    const b = await handle(name);
    await a.c.put({ id: "seen", a: 1 });
    await b.c.clear();
    await a.kv.sync();
    const { events } = listen(a.c);
    await b.c.put({ id: "after", a: 2 });
    await a.kv.sync();
    await settled(() => expect(summary(events)).toEqual(["+after"]));
  });

  it.each([
    ["adds an index", { byA: "a", byB: "b" }],
    ["drops an index, deleting its entries", {}],
  ])("sends no gap for a catalog write that %s", async (_, indexes: Record<string, string>) => {
    type Row = { id: string; a?: number; b?: number };
    const v1 = defineSchema({ version: 1, collections: { rows: collection<Row>().index("byA", "a") } });
    let declared = collection<Row>();
    for (const [index, by] of Object.entries(indexes)) declared = declared.index(index, by as "a") as never;
    const v2 = defineSchema({ version: 2, collections: { rows: declared } });
    const name = freshName();
    const kvA = await openKv(name);
    const kvB = await openKv(name);
    open.push(kvA, kvB);
    const rows = (await openDocStore(kvA, v1)).collection("rows");
    await rows.putMany(Array.from({ length: 700 }, (_, i) => ({ id: `r${i}`, a: i, b: i })));
    const events: CollectionChange<Row>[] = [];
    rows.changes((e) => events.push(e));

    const next = await openDocStore(kvB, v2);
    await next.whenIdle();
    await kvA.sync();
    await rows.put({ id: "last", a: 1 });
    await settled(() => expect(events.map((e) => e.kind)).toEqual(["append"]));
    expect(events[0]).toMatchObject({ kind: "append", changes: [{ id: "last", deleted: false }] });
  });

  it("sends a gap for a dropped collection, nothing while it is gone, and follows it when a later schema declares it again", async () => {
    type Note = { id: string; body?: string };
    const withNotes = (version: number) =>
      defineSchema({ version, collections: { docs: collection<Doc>(), notes: collection<Note>().index("byBody", "body") } });
    const withoutNotes = defineSchema({ version: 2, collections: { docs: collection<Doc>() }, drop: ["notes"] });
    const name = freshName();
    const kvA = await openKv(name);
    const kvB = await openKv(name);
    open.push(kvA, kvB);
    const notes = (await openDocStore(kvA, withNotes(1))).collection("notes");
    await notes.put({ id: "n1", body: "x" });
    const events: CollectionChange<Note>[] = [];
    notes.changes((e) => events.push(e));

    const dropped = await openDocStore(kvB, withoutNotes);
    await dropped.whenIdle();
    await kvA.sync();
    await settled(() => expect(events.map((e) => e.kind)).toEqual(["gap"]));
    await dropped.collection("docs").put({ id: "unrelated" });
    await kvA.sync();

    const again = (await openDocStore(kvB, withNotes(3))).collection("notes");
    await again.put({ id: "n2", body: "y" });
    await kvA.sync();
    await settled(() => expect(events.map((e) => e.kind)).toEqual(["gap", "gap", "append"]));
    expect(events[2]).toMatchObject({ kind: "append", changes: [{ id: "n2", doc: { id: "n2", body: "y" } }] });
  });

  it("sends a gap when its kv handle skips records a flush folded, and goes on reporting afterwards", async () => {
    const name = freshName();
    const writer = await handle(name);
    const reader = await handle(name, openKvWithoutBus);
    await writer.c.put({ id: "x", a: 1 });
    await reader.kv.sync();
    const { events } = listen(reader.c);

    await writer.c.delete("x");
    await writer.c.put({ id: "y", a: 2 });
    await ingest(writer.kv);
    await reader.kv.sync();
    await settled(() => expect(summary(events)).toEqual(["gap"]));
    await writer.c.put({ id: "z", a: 3 });
    await reader.kv.sync();
    await settled(() => expect(summary(events)).toEqual(["gap", "+z"]));
  });

  it("reads the collection's id again after a kv gap, which may have skipped a clear", async () => {
    const name = freshName();
    const writer = await handle(name);
    const reader = await handle(name, openKvWithoutBus);
    await writer.c.put({ id: "x", a: 1 });
    await reader.kv.sync();
    const { events } = listen(reader.c);

    await writer.c.clear();
    await writer.c.put({ id: "y", a: 2 });
    await writer.store.whenIdle();
    await ingest(writer.kv);
    await reader.kv.sync();
    await settled(() => expect(summary(events)).toEqual(["gap"]));
    await writer.c.put({ id: "z", a: 3 });
    await reader.kv.sync();
    await settled(() => expect(summary(events)).toEqual(["gap", "+z"]));
  });

  it("holds the events that arrive before it has read the catalog, and reports each once", async () => {
    const { c } = await handle();
    await c.put({ id: "before", a: 0 });
    const { events } = listen(c);
    for (let i = 1; i <= 5; i++) void c.put({ id: `w${i}`, a: i });
    await settled(() => expect(summary(events)).toHaveLength(5));
    await new Promise((r) => setTimeout(r, 20));
    expect(events.flatMap((e) => (e.kind === "append" ? e.changes.map((ch) => ch.id) : [])).sort()).toEqual(
      ["w1", "w2", "w3", "w4", "w5"],
    );
  });

  it("sends a gap and goes on reporting once it can read the catalog again, after a read that failed", async () => {
    const kv = await openKv(freshName());
    open.push(kv);
    let failing = false;
    const flaky = wrap(kv, {
      view: (body) => (failing ? Promise.reject(new Error("read failed")) : kv.view(body)),
    } as Partial<Db>);
    const c = (await openDocStore(flaky, schema)).collection("docs");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    failing = true;
    const { events } = listen(c);
    await c.put({ id: "1", a: 1 });
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled());
    failing = false;
    await c.put({ id: "2", a: 2 });
    await settled(() => expect(summary(events)).toEqual(["gap"]));
    await c.put({ id: "3", a: 3 });
    await settled(() => expect(summary(events)).toEqual(["gap", "+3"]));
  });

  it("stops reporting after the unsubscribe function is called, and ends with closed when kv closes", async () => {
    const { kv, c } = await handle();
    const stopped = listen(c);
    const live = listen(c);
    await c.put({ id: "a", a: 1 });
    await settled(() => expect(live.events).toHaveLength(1));
    stopped.stop();
    await c.put({ id: "b", a: 2 });
    await settled(() => expect(live.events).toHaveLength(2));
    expect(summary(stopped.events)).toEqual(["+a"]);
    await kv.close();
    expect(live.events.at(-1)).toEqual({ kind: "closed", reason: "close" });
  });

  it("keeps the other listeners and the store working when a listener throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { c } = await handle();
    const seen: string[] = [];
    c.changes(() => {
      throw new Error("listener bug");
    });
    c.changes((e) => seen.push(e.kind));
    await c.put({ id: "a", a: 1 });
    await c.put({ id: "b", a: 2 });
    await settled(() => expect(seen).toEqual(["append", "append"]));
    expect(await c.count({})).toBe(2);
    expect(log).toHaveBeenCalled();
  });

  it("throws ClosedError, as kv does, when its kv handle is already closed", async () => {
    const { kv, c } = await handle();
    await kv.close();
    expect(() => c.changes(() => undefined)).toThrow(ClosedError);
  });
});

describe("before", () => {
  const INDEXES = ["one", "two", "tags"] as const;
  type Entries = Record<(typeof INDEXES)[number], Map<string, unknown[]>>;

  /** Every entry of each index, by document id, as `queryEntries` reads them. */
  async function entriesNow(c: Docs): Promise<Entries> {
    const out = {} as Entries;
    for (const index of INDEXES) {
      const byId = new Map<string, unknown[]>();
      for (const e of (await c.queryEntries({ index } as Parameters<Docs["queryEntries"]>[0])).entries) byId.set(e.id, [...(byId.get(e.id) ?? []), e]);
      out[index] = byId;
    }
    return out;
  }

  /** A small PRNG, so a failure replays. */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("gives each document's entries before a create, a move, an edit that keeps them, a removal from the index and a delete", async () => {
    const { c } = await handle();
    const seen: string[] = [];
    c.changes((e) => {
      if (e.kind !== "append") return;
      for (const ch of e.changes) seen.push(`${ch.id} ${JSON.stringify(ch.before("two"))} ${JSON.stringify(ch.before("tags"))}`);
    });
    await c.put({ id: "x", a: 1, b: "p", tags: ["k", "j", "k"] });
    await c.modify("x", (d) => ({ ...d, a: 2 }));
    await c.modify("x", (d) => ({ ...d, t: "words", u: 7 }));
    await c.modify("x", (d) => ({ id: d.id, a: d.a, tags: ["j"] }));
    await c.delete("x");
    await settled(() => expect(seen).toHaveLength(5));
    expect(seen).toEqual([
      "x [] []",
      'x [{"id":"x","values":[1,"p"]}] [{"id":"x","values":["j","p"]},{"id":"x","values":["k","p"]}]',
      'x [{"id":"x","values":[2,"p"]}] [{"id":"x","values":["j","p"]},{"id":"x","values":["k","p"]}]',
      'x [{"id":"x","values":[2,"p"]}] [{"id":"x","values":["j","p"]},{"id":"x","values":["k","p"]}]',
      "x [] []",
    ]);
  });

  it("matches the entries read before each write, for random writes from this handle and another one", async () => {
    const name = freshName();
    const a = await handle(name);
    const b = await handle(name);
    const random = rng(7);
    const pick = <V>(xs: readonly V[]): V => xs[Math.floor(random() * xs.length)]!;
    const value = () => pick([undefined, null, false, 1, 2, "s", "t"] as const);
    const doc = (id: string): Doc => {
      const d: Doc = { id };
      if (random() < 0.8) d.a = value();
      if (random() < 0.8) d.b = value();
      if (random() < 0.7) d.tags = Array.from({ length: Math.floor(random() * 4) }, () => pick([1, 2, "x", "y"]));
      return d;
    };
    const ids = ["d0", "d1", "d2", "d3", "d4", "d5"];
    const heard: { id: string; deleted: boolean; before: Record<string, unknown> }[][] = [];
    let announced = 0;
    a.kv.changes((e) => {
      if (e.kind === "append") announced = e.seq;
    });
    a.c.changes((e) => {
      if (e.kind !== "append") return;
      heard.push(e.changes.map((ch) => ({ id: ch.id, deleted: ch.deleted, before: Object.fromEntries(INDEXES.map((i) => [i, ch.before(i)])) })));
    });

    let checked = 0;
    for (let step = 0; step < 120; step++) {
      const was = await entriesNow(a.c);
      const writer = random() < 0.5 ? a : b;
      const chosen = ids.filter(() => random() < 0.4);
      if (chosen.length === 0) chosen.push(pick(ids));
      const kind = random();
      if (kind < 0.4) await writer.c.putMany(chosen.map(doc));
      else if (kind < 0.7) {
        // Drawn before the call: `fn` may run more than once.
        const plan = chosen.map((id) => ({ next: random() < 0.3 ? null : random() < 0.2 ? undefined : doc(id), keepA: random() < 0.5 }));
        await writer.c.modifyMany(chosen, (docs) => plan.map(({ next, keepA }, i) => (next && keepA && docs[i] ? { ...next, a: docs[i]!.a } : next)));
      }
      else await writer.c.deleteMany(chosen);
      await a.kv.sync();
      const head = await a.kv.view(async (snap) => snap.seq);
      await settled(() => expect(announced).toBeGreaterThanOrEqual(head));
      for (const ch of heard.splice(0).flat()) {
        checked++;
        expect(ch.before, `step ${step}, ${ch.id}`).toEqual(Object.fromEntries(INDEXES.map((i) => [i, was[i].get(ch.id) ?? []])));
      }
    }
    expect(checked).toBeGreaterThan(150);
  });

  it("throws for an index whose entries hold a value, and for one a newer schema redefined", async () => {
    const { c } = await handle();
    const errors: string[] = [];
    c.changes((e) => {
      if (e.kind !== "append") return;
      const [ch] = e.changes;
      for (const index of ["uniq", "search", "covered"]) {
        try {
          // @ts-expect-error: only a sorted index that is not unique and includes no field
          ch!.before(index);
        } catch (err) {
          errors.push(`${index} ${(err as DocStoreError).code}`);
        }
      }
    });
    await c.put({ id: "x", a: 1 });
    await settled(() => expect(errors).toEqual(["uniq query", "search query", "covered query"]));

    type Row = { id: string; a?: number; b?: number };
    const v1 = defineSchema({ version: 1, collections: { rows: collection<Row>().index("byA", "a") } });
    const v2 = defineSchema({ version: 2, collections: { rows: collection<Row>().index("byA", "b") } });
    const name = freshName();
    const kvA = await openKv(name);
    const kvB = await openKv(name);
    open.push(kvA, kvB);
    const rows = (await openDocStore(kvA, v1)).collection("rows");
    const thrown: unknown[] = [];
    rows.changes((e) => {
      if (e.kind !== "append") return;
      try {
        e.changes[0]!.before("byA");
      } catch (err) {
        thrown.push(err);
      }
    });
    const next = await openDocStore(kvB, v2);
    await next.whenIdle();
    await next.collection("rows").put({ id: "r", a: 1, b: 2 });
    await kvA.sync();
    await settled(() => expect(thrown).toHaveLength(1));
    expect(thrown[0]).toMatchObject({ name: "DocStoreError", code: "schema" });
  });
});

describe("written", () => {
  /** What each change of each write added to and removed from `index`, as the listener reads it. */
  function track(c: Docs, index: "one" | "two" | "tags" = "two") {
    const seen: { id: string; added: unknown[]; removed: unknown[] }[] = [];
    c.changes((e) => {
      if (e.kind === "append") for (const ch of e.changes) seen.push({ id: ch.id, ...ch.written(index) });
    });
    return seen;
  }
  const entry = (id: string, ...values: unknown[]) => ({ id, values });

  it("gives the entries an insert, a move, an update that leaves the index alone and a delete wrote", async () => {
    const { c } = await handle();
    const seen = track(c);
    await c.put({ id: "x", a: 1, b: "p" });
    await c.modify("x", (d) => ({ ...d, a: 2 }));
    await c.modify("x", (d) => ({ ...d, t: "words", u: 7 }));
    await c.delete("x");
    await settled(() => expect(seen).toHaveLength(4));
    expect(seen).toEqual([
      { id: "x", added: [entry("x", 1, "p")], removed: [] },
      { id: "x", added: [entry("x", 2, "p")], removed: [entry("x", 1, "p")] },
      { id: "x", added: [], removed: [] },
      { id: "x", added: [], removed: [entry("x", 2, "p")] },
    ]);
  });

  it("gives the entries of a multi index in index order, and only those the write changed", async () => {
    const { c } = await handle();
    const seen = track(c, "tags");
    await c.put({ id: "x", b: "p", tags: ["k", "j", "k"] });
    await c.modify("x", (d) => ({ ...d, tags: ["j", "m", "a"] }));
    await settled(() => expect(seen).toHaveLength(2));
    expect(seen).toEqual([
      { id: "x", added: [entry("x", "j", "p"), entry("x", "k", "p")], removed: [] },
      { id: "x", added: [entry("x", "a", "p"), entry("x", "m", "p")], removed: [entry("x", "k", "p")] },
    ]);
  });

  it("gives the entries of each document of one write", async () => {
    const { c } = await handle();
    await c.putMany([{ id: "x", a: 1 }, { id: "y", a: 2 }]);
    const seen = track(c, "one");
    await c.modifyMany(["x", "y"], () => [{ id: "x", a: 5 }, null]);
    await settled(() => expect(seen).toHaveLength(2));
    expect(seen).toEqual([
      { id: "x", added: [entry("x", 5)], removed: [entry("x", 1)] },
      { id: "y", added: [], removed: [entry("y", 2)] },
    ]);
  });

  it("gives both writes to the last change of a document that one record writes twice", async () => {
    const source = await handle();
    const ops: ChangeOp[] = [];
    source.kv.changes((e) => e.kind === "append" && ops.push(...e.ops));
    await source.c.put({ id: "x", a: 1, b: "p" });
    await source.c.modify("x", (d) => ({ ...d, a: 2 }));
    await source.c.put({ id: "y", a: 9, b: "q" });
    await settled(() => expect(ops.length).toBeGreaterThanOrEqual(6));

    const { kv, c } = await handle();
    const seen = track(c);
    const rows: unknown[] = [];
    c.changes((e) => e.kind === "append" && rows.push(...e.changes.map((ch) => `${ch.id}${ch.deleted ? "-" : "+"}`)));
    await kv.batch((tx) => {
      for (const op of ops) if (op.type === "put") tx.put(op.key, op.value); else if (op.type === "del") tx.delete(op.key);
    });
    await settled(() => expect(seen).toHaveLength(3));
    expect(rows).toEqual(["x+", "x+", "y+"]);
    expect(seen).toEqual([
      { id: "x", added: [], removed: [] },
      { id: "x", added: [entry("x", 1, "p"), entry("x", 2, "p")], removed: [entry("x", 1, "p")] },
      { id: "y", added: [entry("y", 9, "q")], removed: [] },
    ]);
  });

  it("decodes no document: a change whose stored document cannot be parsed still gives its entries", async () => {
    const source = await handle();
    const ops: ChangeOp[] = [];
    source.kv.changes((e) => e.kind === "append" && ops.push(...e.ops));
    await source.c.put({ id: "x", a: 1, b: "p" });
    await settled(() => expect(ops.length).toBeGreaterThan(1));

    const { kv, c } = await handle();
    const thrown: unknown[] = [];
    const seen: unknown[] = [];
    c.changes((e) => {
      if (e.kind !== "append") return;
      for (const ch of e.changes) {
        seen.push(ch.written("two"));
        try {
          void ch.doc;
        } catch (err) {
          thrown.push(err);
        }
      }
    });
    await kv.batch((tx) => {
      for (const op of ops) if (op.type === "put") tx.put(op.key, op.value.length > 0 ? utf8.encode("{not json") : op.value);
    });
    await settled(() => expect(seen).toHaveLength(1));
    expect(seen).toEqual([{ added: [entry("x", 1, "p")], removed: [] }]);
    expect(thrown[0]).toBeInstanceOf(SyntaxError);
  });

  it("throws for an index whose entries hold a value, as before does", async () => {
    const { c } = await handle();
    const errors: string[] = [];
    c.changes((e) => {
      if (e.kind !== "append") return;
      for (const index of ["uniq", "search", "covered"]) {
        try {
          // @ts-expect-error: only a sorted index that is not unique and includes no field
          e.changes[0]!.written(index);
        } catch (err) {
          errors.push(`${index} ${(err as DocStoreError).code}`);
        }
      }
    });
    await c.put({ id: "x", a: 1 });
    await settled(() => expect(errors).toEqual(["uniq query", "search query", "covered query"]));
  });
});

describe("a snapshot and the changes", () => {
  it("splits the events at snap.seq: those at or below it are in the snapshot and the later ones are not, across two handles", async () => {
    const name = freshName();
    const a = await handle(name);
    const b = await handle(name);
    const log: { seq: number; ids: string[] }[] = [];
    a.c.changes((e) => e.kind === "append" && log.push({ seq: e.seq, ids: e.changes.map((ch) => ch.id) }));

    const snaps: { seq: number; ids: string[] }[] = [];
    const snap = () => a.c.view(async (s) => ({ seq: s.seq, ids: (await s.queryIds({})).ids }));
    for (let i = 0; i < 6; i++) {
      await (i % 2 ? a : b).c.put({ id: `d${i}`, a: i });
      await a.kv.sync();
      snaps.push(await snap());
    }
    const inside = await a.c.view(async (s) => {
      const before = (await s.queryIds({})).ids;
      await b.c.put({ id: "late", a: 9 });
      await a.kv.sync();
      await settled(() => expect(log.some((l) => l.ids.includes("late"))).toBe(true));
      expect((await s.queryIds({})).ids).toEqual(before);
      expect(await s.get("late")).toBeUndefined();
      return { seq: s.seq, ids: before };
    });
    snaps.push(inside);
    await settled(() => expect(log.flatMap((l) => l.ids)).toHaveLength(7));

    for (const s of snaps) {
      const reflected = log.filter((l) => l.seq <= s.seq).flatMap((l) => l.ids);
      expect(s.ids).toEqual([...reflected].sort());
    }
    expect(log.filter((l) => l.seq > inside.seq).flatMap((l) => l.ids)).toEqual(["late"]);
    expect(new Set(log.map((l) => l.seq)).size).toBe(7);
  });

  it("lets a reader subscribe, read, and drop the events its snapshot reflects without a hole or a repeat", async () => {
    const { c } = await handle();
    const { events } = listen(c);
    for (let i = 0; i < 3; i++) await c.put({ id: `before${i}`, a: i });
    let cache = new Set<string>();
    let from = 0;
    await c.view(async (snap) => {
      from = snap.seq;
      cache = new Set((await snap.queryIds({})).ids);
      for (let i = 0; i < 3; i++) void c.put({ id: `during${i}`, a: i });
    });
    await c.put({ id: "after", a: 9 });
    await settled(() => expect(events.length).toBeGreaterThanOrEqual(7));
    for (const e of events) {
      if (e.kind !== "append" || e.seq <= from) continue;
      for (const ch of e.changes) cache[ch.deleted ? "delete" : "add"](ch.id);
    }
    expect([...cache].sort()).toEqual((await c.queryIds({})).ids);
  });
});
