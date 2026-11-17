import { z } from "zod";
import { expect, test } from "vitest";
import { toBase64url } from "../src/bytes.js";
import { baseKey, cursorKey, recordKey } from "../src/local/keys.js";
import { Clock, decodeOutbox, decodeRecord, decodeWireState, MAX_STAMP_MS, stampInRange, stateBytes, UNSET } from "../src/local/record.js";
import type { Stamp } from "../src/local/record.js";
import { outboxRecordKey } from "../src/local/keys.js";
import { collection, defineSchema } from "../src/schema.js";
import type { ServerRev } from "../src/sync/protocol.js";
import {
  List,
  Item,
  Todo,
  baseOf,
  coll,
  cursor,
  INCARNATION,
  newId,
  openTab,
  pending,
  put,
  randomSpace,
  recordChanges,
  recordItem,
  remoteState,
  serverPage,
  spaceBytesOf,
  uniqueName,
} from "./local-util.js";

const far = new Clock(3, () => 2_000_000_000_000);
const tick = () => new Promise<void>((r) => setTimeout(r, 20));

test("applyRemote drops items whose id belongs to another space and writes nothing for them", async () => {
  const tab = await openTab(uniqueName());
  const mine = randomSpace();
  const other = randomSpace();
  const foreign = newId(other);
  const items = [
    recordItem(foreign, 1, remoteState("lists", { title: "stolen" }, far)),
    { kind: "tomb" as const, id: newId(other), rev: 2 as ServerRev, tomb: { coll: "lists", deletedAt: far.next() } },
    { kind: "richText" as const, id: foreign, field: 1 as never, rev: 3 as ServerRev, update: new Uint8Array([1]) },
  ];
  const { events, stop } = recordChanges(tab.kv);
  const out = await tab.store.applyRemote({ source: "server", space: spaceBytesOf(mine), items, through: undefined, skippedUnknown: false });
  stop();
  expect(out).toEqual({ dropped: 3 });
  expect(events).toHaveLength(0);
  expect(await tab.store.get(coll(tab, "lists"), foreign)).toBeUndefined();
  const good = newId(mine);
  const mixed = await tab.store.applyRemote(serverPage(mine, [items[0]!, recordItem(good, 4, remoteState("lists", { title: "ok" }, far))], 4));
  expect(mixed).toEqual({ dropped: 1 });
  expect(await tab.store.get(coll(tab, "lists"), good)).toMatchObject({ title: "ok" });
  expect(await tab.store.get(coll(tab, "lists"), foreign)).toBeUndefined();
});

test("an ack and a base-only raise write the base key and wake no watcher", async () => {
  const tab = await openTab(uniqueName());
  const space = randomSpace();
  const id = newId(space);
  const lists = coll(tab, "lists");
  let fired = 0;
  tab.store.watch(lists, () => fired++);
  await put(tab, "lists", id, { title: "t" }, true);
  await tick();
  expect(fired).toBe(1);
  const [p] = await pending(tab, space);
  const { events, stop } = recordChanges(tab.kv);
  await tab.store.acknowledge(spaceBytesOf(space), 2 as ServerRev, [{ id, coll: lists.id, stamp: p!.stamp }]);
  expect(await baseOf(tab, id)).toBe(2);
  // the same state again at a higher rev: only the base moves
  const stored = decodeRecord((await tab.kv.get(recordKey(lists.id, id)))!).state;
  await tab.store.applyRemote(serverPage(space, [recordItem(id, 5, stored)], 5));
  expect(await baseOf(tab, id)).toBe(5);
  await tick();
  expect(fired).toBe(1);
  const keys = events.flatMap((e) => (e.kind === "append" ? e.ops.flatMap((o) => (o.type === "deleteRange" ? [] : [o.key])) : []));
  expect(keys.some((k) => toBase64url(k) === toBase64url(recordKey(lists.id, id)))).toBe(false);
  expect(keys.some((k) => toBase64url(k) === toBase64url(baseKey(id)))).toBe(true);
  stop();
  // delete removes the base key
  await tab.store.write([{ kind: "delete", coll: lists, id }]);
  expect(await tab.kv.get(baseKey(id))).toBeUndefined();
  // a late ack of a deleted record writes no base
  await tab.store.acknowledge(spaceBytesOf(space), 6 as ServerRev, [{ id, coll: lists.id, stamp: p!.stamp }]);
  expect(await tab.kv.get(baseKey(id))).toBeUndefined();
});

test("acknowledge moves the cursor only from rev - 1, keeps its incarnation, and never creates one", async () => {
  const tab = await openTab(uniqueName());
  const space = randomSpace();
  const sb = spaceBytesOf(space);
  const lists = coll(tab, "lists");
  const id = newId(space);
  await put(tab, "lists", id, { title: "t" }, true);
  const [p] = await pending(tab, space);
  const ack = [{ id, coll: lists.id, stamp: p!.stamp }];
  await tab.store.acknowledge(sb, 5 as ServerRev, ack);
  expect(await tab.store.readCursor(sb)).toBeUndefined();
  await tab.store.applyRemote(serverPage(space, [], 4));
  await tab.store.acknowledge(sb, 5 as ServerRev, ack);
  expect(await tab.store.readCursor(sb)).toEqual(cursor(5));
  await tab.store.acknowledge(sb, 7 as ServerRev, ack); // a gap: pull must fetch rev 6
  expect(await tab.store.readCursor(sb)).toEqual(cursor(5));
});

const Extra = collection("extras", { label: z.string() });

test("a version that adds a collection deletes only the cursors that skipped something", async () => {
  const name = uniqueName();
  const v1 = await openTab(name);
  const flagged = randomSpace();
  const clean = randomSpace();
  await v1.store.applyRemote(serverPage(flagged, [], 3, true));
  await v1.store.applyRemote(serverPage(clean, [], 4, false));
  expect(await v1.store.readCursor(spaceBytesOf(flagged))).toEqual(cursor(3));
  const v2 = await openTab(name, defineSchema({ version: 2, collections: [List, Todo, Item, Extra] }));
  expect(await v2.store.readCursor(spaceBytesOf(flagged))).toBeUndefined();
  expect(await v2.store.readCursor(spaceBytesOf(clean))).toEqual(cursor(4));
  // the flag is sticky across pages and follows an incarnation change
  await v2.store.applyRemote(serverPage(clean, [], 5, true));
  await v2.store.applyRemote(serverPage(clean, [], 6, false));
  expect(await v2.kv.get(cursorKey(spaceBytesOf(clean)))).toHaveLength(25);
  expect((await v2.kv.get(cursorKey(spaceBytesOf(clean))))![24]).toBe(1);
  // a version that adds no collection leaves every cursor alone
  const v3 = await openTab(name, defineSchema({ version: 3, collections: [List, Todo, Item, Extra] }));
  expect(await v3.store.readCursor(spaceBytesOf(clean))).toEqual(cursor(6));
});

test("a bump keeps unchanged indexes and their entries, and builds only the new one", async () => {
  const name = uniqueName();
  const v1 = await openTab(name);
  const space = randomSpace();
  const id = newId(space);
  await put(v1, "todos", id, { list: toBase64url(newId(space)), title: "t", position: "p" }, true);
  const before = coll(v1, "todos").indexes.map((i) => i.id);
  const { events, stop } = recordChanges(v1.kv);
  const Todo2 = collection("todos", Todo.shape, {
    indexes: { byList: ["list", "position"], byDone: ["done", "title"], byTitle: ["title"] },
  });
  const v2 = await openTab(name, defineSchema({ version: 2, collections: [List, Todo2, Item] }));
  await v1.kv.sync();
  stop();
  const after = coll(v2, "todos").indexes;
  expect(after.slice(0, 2).map((i) => i.id)).toEqual(before);
  expect(after[2]!.id).not.toBe(before[0]);
  // the only index entry written is the new index's
  const puts = events.flatMap((e) => (e.kind === "append" ? e.ops.filter((o) => o.type === "put" && o.key[1] === 0x03) : []));
  expect(puts).toHaveLength(1);
  expect(puts[0]!.type === "put" && puts[0]!.key[3]).toBe(after[2]!.id);
});

test("the upgrade pass visits only records with an invalid cell, and a loosened validator brings them back", async () => {
  const name = uniqueName();
  const strict = collection("notes", { title: z.string().min(5) });
  const loose = collection("notes", { title: z.string() });
  const v1 = await openTab(name, defineSchema({ version: 1, collections: [strict] }));
  const space = randomSpace();
  const good = newId(space);
  const bad = newId(space);
  await put(v1, "notes", good, { title: "long enough" }, true);
  // what the engine stores for a wire value the strict validator refused
  const state = remoteState("notes", { title: "abc" }, far);
  const refused = { coll: "notes", cells: new Map([...state.cells].map(([k, c]) => [k, { ...c, valid: false }])) };
  await v1.store.applyRemote(serverPage(space, [recordItem(bad, 1, refused)], 1));
  expect(await v1.store.status(coll(v1, "notes"), bad)).toBe("unreadable");
  const goodBefore = await v1.kv.get(recordKey(coll(v1, "notes").id, good));

  const { events, stop } = recordChanges(v1.kv);
  const v2 = await openTab(name, defineSchema({ version: 2, collections: [loose] }));
  await v1.kv.sync();
  stop();
  expect(await v2.store.get(coll(v2, "notes"), bad)).toMatchObject({ title: "abc" });
  expect(await v2.kv.get(recordKey(coll(v2, "notes").id, good))).toEqual(goodBefore);
  const touched = events.flatMap((e) => (e.kind === "append" ? e.ops.filter((o) => o.type === "put" && o.key[1] === 0x01).map((o) => (o.type === "put" ? toBase64url(o.key) : "")) : []));
  expect(touched).toEqual([toBase64url(recordKey(coll(v2, "notes").id, bad))]);
});

test("an unset cell stays unset when a default is added to its field later", async () => {
  const name = uniqueName();
  const before = collection("opts", { title: z.string(), n: z.string().optional() });
  const v1 = await openTab(name, defineSchema({ version: 1, collections: [before] }));
  const id = newId(randomSpace());
  await put(v1, "opts", id, { title: "t", n: "x" }, true);
  await put(v1, "opts", id, { n: UNSET });
  const stampBefore = decodeRecord((await v1.kv.get(recordKey(coll(v1, "opts").id, id)))!).state.cells.get("n")!.stamp;
  const after = collection("opts", { title: z.string(), n: z.string().default("d") });
  const v2 = await openTab(name, defineSchema({ version: 2, collections: [after] }));
  const opts = coll(v2, "opts");
  expect(await v2.store.get(opts, id)).toMatchObject({ title: "t", n: "d" });
  const value = (await v2.kv.get(recordKey(opts.id, id)))!;
  const cell = decodeRecord(value).state.cells.get("n")!;
  expect(cell.value).toBe(UNSET);
  expect(cell.stamp).toBe(stampBefore);
  expect(decodeWireState(stateBytes(value)).cells.get("n")?.value).toBe(UNSET);
  // a later write by this version sets it for real
  await put(v2, "opts", id, { n: "set" });
  expect(await v2.store.get(opts, id)).toMatchObject({ n: "set" });
});

test("a stamp beyond the year 3000 is refused, and the clock never issues one", async () => {
  const tab = await openTab(uniqueName());
  const space = randomSpace();
  const id = newId(space);
  const ok = remoteState("lists", { title: "fine" }, far);
  const huge = `z${ok.cells.get("title")!.stamp.slice(1)}` as Stamp;
  expect(stampInRange(huge)).toBe(false);
  expect(stampInRange(ok.cells.get("title")!.stamp)).toBe(true);
  const frozen = { coll: "lists", cells: new Map([["title", { stamp: huge, value: "frozen", valid: true }]]) };
  await tab.store.applyRemote(serverPage(space, [recordItem(id, 1, frozen)], 1));
  expect(await tab.store.get(coll(tab, "lists"), id)).toBeUndefined();
  // the field is not frozen: a later write lands
  await tab.store.applyRemote(serverPage(space, [recordItem(id, 2, ok)], 2));
  await put(tab, "lists", id, { title: "mine" });
  expect(await tab.store.get(coll(tab, "lists"), id)).toMatchObject({ title: "mine" });
  const late = new Clock(1, () => MAX_STAMP_MS * 2);
  const stamp = late.next();
  expect(stampInRange(stamp)).toBe(true);
  late.observe(huge);
  expect(stampInRange(late.next(huge))).toBe(true);
  expect(decodeOutbox((await tab.kv.get(outboxRecordKey(id)))!).stamp).toBeTruthy();
});

test("requeueSpace writes the cursor in its last update, so a crash before it leaves the old cursor", async () => {
  const tab = await openTab(uniqueName());
  const space = randomSpace();
  const sb = spaceBytesOf(space);
  const lists = coll(tab, "lists");
  const id = newId(space);
  await put(tab, "lists", id, { title: "t" }, true);
  const [p] = await pending(tab, space);
  await tab.store.applyRemote(serverPage(space, [], 8));
  await tab.store.acknowledge(sb, 9 as ServerRev, [{ id, coll: lists.id, stamp: p!.stamp }]);
  expect(await baseOf(tab, id)).toBe(9);

  // The last kv.update of a requeue is the cursor write: make it fail.
  const original = tab.kv.update.bind(tab.kv);
  let calls = 0;
  let failAt = Infinity;
  (tab.kv as { update: unknown }).update = (keys: never, body: never) => {
    if (++calls >= failAt) return Promise.reject(new Error("power loss"));
    return original(keys, body);
  };
  await tab.store.requeueSpace(sb, INCARNATION);
  const total = calls;
  expect(await tab.store.readCursor(sb)).toEqual({ incarnation: INCARNATION, rev: 0 });

  await tab.store.applyRemote(serverPage(space, [], 8));
  await put(tab, "lists", id, { title: "again" });
  calls = 0;
  failAt = total;
  await expect(tab.store.requeueSpace(sb, INCARNATION)).rejects.toThrow("power loss");
  // everything but the cursor was written: the old cursor still disagrees with the server
  expect(await tab.store.readCursor(sb)).toEqual(cursor(8));
  expect(await baseOf(tab, id)).toBe(0);
  expect(await pending(tab, space)).toHaveLength(1);
  failAt = Infinity;
  await tab.store.requeueSpace(sb, INCARNATION);
  expect(await tab.store.readCursor(sb)).toEqual({ incarnation: INCARNATION, rev: 0 });
});
