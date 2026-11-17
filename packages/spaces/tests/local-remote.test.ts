import { expect, test } from "vitest";
import { toBase64url } from "../src/bytes.js";
import { cursorKey, outboxRecordKey, recordKey } from "../src/local/keys.js";
import { Clock, decodeOutbox, decodeWireState, encodeTomb, stateBytes } from "../src/local/record.js";
import type { RemotePage } from "../src/local/store.js";
import { tagOf } from "../src/ids.js";
import {
  coll,
  cursor,
  INCARNATION,
  del,
  newId,
  openTab,
  pending,
  put,
  randomSpace,
  recordChanges,
  recordItem,
  serverPage,
  baseOf,
  remoteState,
  spaceBytesOf,
  tagOfSpace,
  uniqueName,
} from "./local-util.js";
import type { ServerRev } from "../src/sync/protocol.js";

const far = new Clock(3, () => 2_000_000_000_000);

test("applyRemote is idempotent, and the cursor lands in the same batch", async () => {
  const tab = await openTab(uniqueName());
  const space = randomSpace();
  const id = newId(space);
  const { events, stop } = recordChanges(tab.kv);
  const page = serverPage(space, [recordItem(id, 3, remoteState("lists", { title: "hello" }, far))], 3);
  await tab.store.applyRemote(page);
  const appends = events.filter((e) => e.kind === "append");
  expect(appends).toHaveLength(1);
  const keys = appends[0]!.kind === "append" ? appends[0]!.ops.map((o) => (o.type === "deleteRange" ? undefined : o.key)) : [];
  const has = (k: Uint8Array) => keys.some((x) => x && toBase64url(x) === toBase64url(k));
  expect(has(cursorKey(spaceBytesOf(space)))).toBe(true);
  expect(has(recordKey(coll(tab, "lists").id, id))).toBe(true);
  expect(await tab.store.readCursor(spaceBytesOf(space))).toEqual(cursor(3));

  await tab.store.applyRemote(page);
  expect(events.filter((e) => e.kind === "append")).toHaveLength(1);
  stop();
  expect(await baseOf(tab, id)).toBe(3);
});

test("a tombstone drops later items, and an older page cannot move the cursor back", async () => {
  const tab = await openTab(uniqueName());
  const space = randomSpace();
  const id = newId(space);
  await tab.store.applyRemote(serverPage(space, [recordItem(id, 1, remoteState("lists", { title: "a" }, far))], 1));
  const tomb = { coll: "lists", deletedAt: far.next() };
  await tab.store.applyRemote(serverPage(space, [{ kind: "tomb", id, rev: 2 as ServerRev, tomb }], 2));
  expect(await tab.store.get(coll(tab, "lists"), id)).toBeUndefined();
  await tab.store.applyRemote(serverPage(space, [recordItem(id, 3, remoteState("lists", { title: "late" }, far))], 3));
  expect(await tab.store.get(coll(tab, "lists"), id)).toBeUndefined();
  expect(await tab.store.status(coll(tab, "lists"), id)).toBe("deleted");
  await tab.store.applyRemote(serverPage(space, [], 1));
  expect(await tab.store.readCursor(spaceBytesOf(space))).toEqual(cursor(3));
  // a tombstone is also kept for a record this device never saw
  const stranger = newId(space);
  await tab.store.applyRemote(serverPage(space, [{ kind: "tomb", id: stranger, rev: 4 as ServerRev, tomb }], 4));
  expect(await tab.store.status(coll(tab, "lists"), stranger)).toBe("deleted");
  expect(encodeTomb(tomb)).toBeTruthy();
});

test("a remote tombstone also clears the pending outbox entry", async () => {
  const tab = await openTab(uniqueName());
  const space = randomSpace();
  const id = newId(space);
  await put(tab, "lists", id, { title: "mine" }, true);
  expect(await pending(tab, space)).toHaveLength(1);
  await tab.store.applyRemote(
    serverPage(space, [{ kind: "tomb", id, rev: 1 as ServerRev, tomb: { coll: "lists", deletedAt: far.next() } }], 1),
  );
  expect(await pending(tab, space)).toHaveLength(0);
  expect(await tab.kv.get(outboxRecordKey(id))).toBeUndefined();
});

test("merge keeps the newer cell per field, and the outbox keeps a record that is ahead of the server", async () => {
  const tab = await openTab(uniqueName());
  const space = randomSpace();
  const id = newId(space);
  await put(tab, "todos", id, { list: toBase64url(newId(space)), title: "local", position: "p" }, true);
  const lists = coll(tab, "todos");
  // The server has an older title and a field we lack.
  const old = new Clock(1, () => 1_000);
  const theirs = remoteState("todos", { title: "server", note: "n" }, old);
  await tab.store.applyRemote(serverPage(space, [recordItem(id, 5, theirs)], 5));
  expect(await tab.store.get(lists, id)).toMatchObject({ title: "local", note: "n" });
  const [p] = await pending(tab, space);
  expect(p?.kind).toBe("record");
  expect(p?.kind === "record" && p.base).toBe(5);
  // a state that covers everything clears the entry
  const value = await tab.kv.get(recordKey(lists.id, id));
  const full = decodeWireState(stateBytes(value!));
  const cells = new Map([...full.cells].map(([k, c]) => [k, { ...c, valid: true }]));
  await tab.store.applyRemote(serverPage(space, [recordItem(id, 6, { coll: "todos", cells })], 6));
  expect(await pending(tab, space)).toHaveLength(0);
});

test("a peer page that changes a record queues it for push, and one that does not leaves the queue alone", async () => {
  const tab = await openTab(uniqueName());
  const space = randomSpace();
  const id = newId(space);
  const item = recordItem(id, 0, remoteState("lists", { title: "peer" }, far));
  const page: RemotePage = { source: "peer", space: spaceBytesOf(space), items: [item] };
  await tab.store.applyRemote(page);
  expect(await pending(tab, space)).toHaveLength(1);
  await tab.store.acknowledge(spaceBytesOf(space), 9 as ServerRev, [{ id, coll: coll(tab, "lists").id, stamp: decodeOutbox((await tab.kv.get(outboxRecordKey(id)))!).stamp }]);
  expect(await pending(tab, space)).toHaveLength(0);
  await tab.store.applyRemote(page);
  expect(await pending(tab, space)).toHaveLength(0);
});

test("acknowledge clears an outbox entry only if its stamp is unchanged, and raises the base", async () => {
  const tab = await openTab(uniqueName());
  const space = randomSpace();
  const id = newId(space);
  const lists = coll(tab, "lists");
  await put(tab, "lists", id, { title: "one" }, true);
  const [first] = await pending(tab, space);
  await put(tab, "lists", id, { title: "two" });
  await tab.store.acknowledge(spaceBytesOf(space), 4 as ServerRev, [{ id, coll: lists.id, stamp: first!.stamp }]);
  const [still] = await pending(tab, space);
  expect(still).toBeDefined();
  expect(still!.kind === "record" && still!.base).toBe(4);
  await tab.store.acknowledge(spaceBytesOf(space), 5 as ServerRev, [{ id, coll: lists.id, stamp: still!.stamp }]);
  expect(await pending(tab, space)).toHaveLength(0);
  // running it twice changes nothing
  const { events, stop } = recordChanges(tab.kv);
  await tab.store.acknowledge(spaceBytesOf(space), 5 as ServerRev, [{ id, coll: lists.id, stamp: still!.stamp }]);
  stop();
  expect(events).toHaveLength(0);
  // a tombstone ack clears the tombstone entry
  await del(tab, "lists", id);
  const [tomb] = await pending(tab, space);
  expect(tomb?.kind).toBe("tomb");
  await tab.store.acknowledge(spaceBytesOf(space), 6 as ServerRev, [{ id, coll: "tomb", stamp: tomb!.stamp }]);
  expect(await pending(tab, space)).toHaveLength(0);
});

test("pendingRecords is per space and carries the wire plaintext", async () => {
  const tab = await openTab(uniqueName());
  const s1 = randomSpace();
  const s2 = randomSpace();
  const a = newId(s1);
  await put(tab, "lists", a, { title: "a" }, true);
  await put(tab, "lists", newId(s2), { title: "b" }, true);
  const [p] = await pending(tab, s1);
  expect(await pending(tab, s2)).toHaveLength(1);
  expect(p!.kind === "record" && decodeWireState(p!.plaintext).cells.get("title")?.value).toBe("a");
});

test("requeueSpace resets bases and queues every record and tombstone of the space", async () => {
  const tab = await openTab(uniqueName());
  const s1 = randomSpace();
  const s2 = randomSpace();
  const live = newId(s1);
  const dead = newId(s1);
  const other = newId(s2);
  const lists = coll(tab, "lists");
  for (const [sp, id] of [[s1, live], [s1, dead], [s2, other]] as const) {
    await put(tab, "lists", id, { title: "x" }, true);
    const p = (await pending(tab, sp)).find((e) => toBase64url(e.id) === toBase64url(id))!;
    await tab.store.acknowledge(spaceBytesOf(sp), 7 as ServerRev, [{ id, coll: lists.id, stamp: p.stamp }]);
  }
  await del(tab, "lists", dead);
  const [t] = (await pending(tab, s1)).filter((e) => e.kind === "tomb");
  await tab.store.acknowledge(spaceBytesOf(s1), 8 as ServerRev, [{ id: dead, coll: "tomb", stamp: t!.stamp }]);
  await tab.store.applyRemote(serverPage(s1, [], 8));
  expect(await pending(tab, s1)).toHaveLength(0);

  await tab.store.requeueSpace(spaceBytesOf(s1), INCARNATION);
  expect(await tab.store.readCursor(spaceBytesOf(s1))).toEqual({ incarnation: INCARNATION, rev: 0 });
  const queued = await pending(tab, s1);
  expect(queued.map((q) => q.kind).sort()).toEqual(["record", "tomb"]);
  expect(queued.find((q) => q.kind === "record")!.kind === "record" && (queued.find((q) => q.kind === "record") as { base: number }).base).toBe(0);
  expect(await pending(tab, s2)).toHaveLength(0);
  expect(await baseOf(tab, other)).toBe(7);
  expect(tagOf(s1)).toEqual(tagOfSpace(s1));
});

test("a rich-text update from the server is stored once and dropped for a deleted record", async () => {
  const tab = await openTab(uniqueName());
  const space = randomSpace();
  const id = newId(space);
  const field = (await import("../src/local/keys.js")).fieldHash("body");
  const update = { kind: "richText" as const, id, field, rev: 4 as ServerRev, update: new Uint8Array([5, 5]) };
  const { events, stop } = recordChanges(tab.kv);
  await tab.store.applyRemote(serverPage(space, [update], 4));
  await tab.store.applyRemote(serverPage(space, [update], 4));
  expect(events.filter((e) => e.kind === "append")).toHaveLength(1);
  stop();
  expect((await tab.store.loadRichText(id, field)).updates).toHaveLength(1);
  await tab.store.applyRemote(serverPage(space, [{ kind: "tomb", id, rev: 5 as ServerRev, tomb: { coll: "todos", deletedAt: far.next() } }], 5));
  expect((await tab.store.loadRichText(id, field)).updates).toHaveLength(0);
  await tab.store.applyRemote(serverPage(space, [{ ...update, rev: 6 as ServerRev }], 6));
  expect((await tab.store.loadRichText(id, field)).updates).toHaveLength(0);
});

test("rich-text trim keeps updates written after the snapshot and refuses while updates are unpushed", async () => {
  const tab = await openTab(uniqueName());
  const id = newId(randomSpace());
  await put(tab, "todos", id, { list: toBase64url(newId(randomSpace())), title: "t", position: "p" }, true);
  const field = (await import("../src/local/keys.js")).fieldHash("body");
  await tab.store.appendRichText(id, field, 1, 1, new Uint8Array([1]));
  const loaded = await tab.store.loadRichText(id, field);
  expect(loaded.unpushed).toBe(1);
  expect(await tab.store.trimRichText(id, field, loaded.through, 1, 2, new Uint8Array([7]))).toBe(false);
  const space = tagOf(toBase64url(id) as never);
  const [group] = await tab.store.pendingRichText(space, 10);
  expect(group!.updates).toHaveLength(1);
  await tab.store.acknowledgeRichText(group!.outboxKeys);
  await tab.store.appendRichText(id, field, 1, 3, new Uint8Array([3]));
  // the trim covers what was loaded, not the update that came after
  const { through } = await tab.store.loadRichText(id, field);
  await tab.store.appendRichText(id, field, 1, 4, new Uint8Array([4]));
  const [late] = await tab.store.pendingRichText(space, 10);
  await tab.store.acknowledgeRichText(late!.outboxKeys);
  expect(await tab.store.trimRichText(id, field, through, 1, 5, new Uint8Array([9]))).toBe(true);
  const after = (await tab.store.loadRichText(id, field)).updates.map((u) => u[0]);
  expect(after).toContain(9);
  expect(after).toContain(4);
  expect(after).not.toContain(1);
});
