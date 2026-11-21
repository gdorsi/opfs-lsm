import type { ChangeEvent, Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { z } from "zod";
import { toBase64url } from "../src/bytes.js";
import { newRecordId, recordBytes, tagOf } from "../src/ids.js";
import type { RecordKeyId, SpaceBytes, SpaceId } from "../src/ids.js";
import { LocalStore } from "../src/local/store.js";
import type { BoundCollection, PendingRecord, RemoteItem, WriteOp } from "../src/local/store.js";
import { Clock } from "../src/local/record.js";
import type { CellValue, RecordState, Stamp } from "../src/local/record.js";
import { collection, defineSchema, file, ref, richText } from "../src/schema.js";
import type { SchemaDef } from "../src/schema.js";
import type { Incarnation, PullCursor, ServerRev } from "../src/sync/protocol.js";
import type { RemoteItem as Item2, RemotePage } from "../src/local/store.js";
import { baseKey } from "../src/local/keys.js";
import { decodeBase } from "../src/local/record.js";
import { spaceBytes } from "../src/ids.js";

export const List = collection("lists", { title: z.string().min(1) });
export const Todo = collection(
  "todos",
  {
    list: ref("lists"),
    title: z.string().min(1),
    done: z.boolean().default(false),
    position: z.string(),
    note: z.string().optional(),
    body: richText(),
    image: file().optional(),
  },
  { indexes: { byList: ["list", "position"], byDone: ["done", "title"] } },
);
export const Item = collection("items", { todo: ref("todos"), label: z.string() });

export const schemaV1 = defineSchema({ version: 1, collections: [List, Todo, Item] });
/** The same schema one version later, with one more index. */
const Todo2 = collection("todos", Todo.shape, {
  indexes: { byList: ["list", "position"], byDone: ["done", "title"], byTitle: ["title"] },
});
export const schemaV2 = defineSchema({ version: 2, collections: [List, Todo2, Item] });

let counter = 0;
export const uniqueName = (prefix = "t") => `spaces-${prefix}-${process.pid}-${Date.now()}-${counter++}`;

export type Tab = { kv: Db; store: LocalStore; clock: Clock };

export async function openTab(name: string, schema: SchemaDef = schemaV1, now?: () => number): Promise<Tab> {
  const kv = await openHarnessDb({ name, forceMemory: true });
  const clock = new Clock(Math.floor(Math.random() * 2 ** 32), now);
  const store = await LocalStore.open(kv, schema, clock);
  return { kv, store, clock };
}

export const coll = (tab: Tab, name: string): BoundCollection => tab.store.catalog.collections.get(name)!;

export const randomSpace = (): SpaceId => toBase64url(crypto.getRandomValues(new Uint8Array(16))) as SpaceId;

export const patchOf = (values: Record<string, CellValue>): Map<string, CellValue> => new Map(Object.entries(values));

export function put(tab: Tab, collName: string, id: RecordKeyId, values: Record<string, CellValue>, create = false): Promise<void> {
  const op: WriteOp = { kind: "put", coll: coll(tab, collName), id, create, patch: patchOf(values), files: [] };
  return tab.store.write([op]);
}

export const del = (tab: Tab, collName: string, id: RecordKeyId): Promise<void> =>
  tab.store.write([{ kind: "delete", coll: coll(tab, collName), id }]);

export const newId = (space: SpaceId): RecordKeyId => recordBytes(newRecordId(space));

/** A record state as a remote device would send it, every cell valid. */
export function remoteState(collName: string, values: Record<string, CellValue>, clock: Clock): RecordState {
  const cells = new Map<string, { stamp: Stamp; value: CellValue; valid: boolean }>();
  for (const [field, value] of Object.entries(values)) cells.set(field, { stamp: clock.next(), value, valid: true });
  return { coll: collName, cells };
}

export const recordItem = (id: RecordKeyId, rev: number, state: RecordState): RemoteItem => ({
  kind: "record",
  id,
  rev: rev as ServerRev,
  state,
});

export const INCARNATION = new Uint8Array(16).fill(7) as Incarnation;
export const cursor = (rev: number): PullCursor => ({ incarnation: INCARNATION, rev: rev as ServerRev });

export const spaceBytesOf = (space: SpaceId): SpaceBytes => spaceBytes(space);
export const tagOfSpace = (space: SpaceId) => tagOf(space);

/** Every change event this handle announces, with the ops of each append. */
export function recordChanges(kv: Db): { events: ChangeEvent[]; stop: () => void } {
  const events: ChangeEvent[] = [];
  const stop = kv.changes((e) => events.push(e));
  return { events, stop };
}

export const pending = (tab: Tab, space: SpaceId): Promise<PendingRecord[]> => tab.store.pendingRecords(tagOf(space), 100);


export const serverPage = (space: SpaceId, items: readonly Item2[], rev: number, skippedUnknown = false): RemotePage => ({
  source: "server",
  space: spaceBytesOf(space),
  items,
  through: cursor(rev),
  skippedUnknown,
});

/** The base rev a record holds at its own key. */
export const baseOf = async (tab: Tab, id: RecordKeyId): Promise<number> => decodeBase(await tab.kv.get(baseKey(id)));
