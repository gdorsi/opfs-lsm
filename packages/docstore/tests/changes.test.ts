import { ingest } from "@opfs-lsm/kv/testing";
import { ClosedError, type Db } from "@opfs-lsm/kv";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineSchema, openDocStore, type CollectionChange } from "../src/index.js";
import { concat } from "../src/keys.js";
import { schema, type Doc, type Docs } from "./docs.js";
import { freshName, openKv, openKvWithoutBus, storedPrefix, wrap } from "./harness.js";

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
    await settled(() => expect(summary(events)).toEqual(["+2", "gap", "+3"]));
    expect(await c.get("1")).toBeUndefined();
  });

  it("ignores the entries of the indexes and the other collections", async () => {
    type Other = { id: string; x?: number };
    const two = defineSchema<{ docs: Doc; other: Other }>()({
      version: 1,
      collections: { docs: { one: { on: "a" }, tags: { on: "tags", multi: true } }, other: { byX: { on: "x" } } },
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

  it("sends a gap for clear(), then reports the writes made after it, and nothing of the sweep", async () => {
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

  it("sends no gap for catalog writes that leave the collection's id alone", async () => {
    type Row = { id: string; a?: number; b?: number };
    const v1 = defineSchema<{ rows: Row }>()({ version: 1, collections: { rows: { byA: { on: "a" } } } });
    const v2 = defineSchema<{ rows: Row }>()({
      version: 2,
      collections: { rows: { byA: { on: "a" }, byB: { on: "b" } } },
    });
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
      defineSchema<{ docs: Doc; notes: Note }>()({ version, collections: { docs: {}, notes: { byBody: { on: "body" } } } });
    const withoutNotes = defineSchema<{ docs: Doc }>()({ version: 2, collections: { docs: {} }, drop: ["notes"] });
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
    expect(live.events.at(-1)).toEqual({ kind: "closed" });
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
