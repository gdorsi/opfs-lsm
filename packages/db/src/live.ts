/*
 * `query`: one-shot runs, subscriptions, the rule that says when a change may
 * alter a result, the batching of reruns, and row identity.
 */
import type { CollectionChange, DocChange } from "@opfs-lsm/docstore";
import { IR, root, type Buildable, type QueryRoot } from "./builder.js";
import { tableOf, type Table } from "./database.js";
import { ClosedError, wrap, type AnyDbError } from "./errors.js";
import { execute, type Compiled, type Found } from "./execute.js";
import { compareRows, compile, fieldAt, orderKeyOf, valueAt, type OrderKey, type Scalar } from "./expr.js";
import { dotPath, entryInRanges, keyOnly, planQuery, summarize } from "./plan.js";
import type { JsonDoc } from "./schema.js";

/** How a query reads, as `explain()` shows it. */
export type PlanSummary =
  | { readonly kind: "none" | "ids" }
  | { readonly kind: "index"; readonly index: string; readonly ranges: number; readonly ordered: boolean; readonly exact: boolean }
  | { readonly kind: "scan"; readonly ordered: boolean; readonly exact: boolean };

/** A query bound to its database. Building one reads nothing. */
export interface LiveQuery<V> {
  /** One read, from one snapshot. Rejects with a DbError. */
  run(): Promise<V>;
  /**
   * `next` gets the result after the first read, then each time it changes,
   * never synchronously. `error` gets the DbError that ended the
   * subscription, a ClosedError included, and nothing is called after it.
   * The returned function stops every call, a read in flight included.
   */
  subscribe(next: (value: V) => void, error?: (error: AnyDbError) => void): () => void;
  /** How the query reads. Throws the QueryError of a query that cannot run. */
  explain(): PlanSummary;
}

/**
 * Build a query. `build` runs once, now. The collection handle it reads
 * names the database, so there is no database to pass.
 */
export function query<V>(build: (q: QueryRoot) => Buildable<V>): LiveQuery<V> {
  const ir = build(root)[IR];
  let compiled: Compiled | undefined;
  const ready = (): Compiled => {
    if (compiled) return compiled;
    const table = tableOf(ir.from.collection);
    const order = orderKeyOf(ir.orderBy);
    return (compiled = { ir, table, order, where: compile(ir.where, ir.from.alias), plan: planQuery(ir, order, table.docs.indexes) });
  };
  /** The query, once it can read: it compiles, and its database is open. */
  const open = (): Compiled => {
    const q = ready();
    if (q.table.owner.closed) throw new ClosedError("closed");
    return q;
  };
  return {
    async run() {
      try {
        const q = open();
        return valueOf(q, await q.table.docs.view((snap) => execute(snap, q))) as V;
      } catch (err) {
        throw wrap(err);
      }
    },
    subscribe(next, error) {
      try {
        const q = open();
        const sub: Subscription = { q, patch: patchOf(q), next: next as (value: unknown) => void, error, result: undefined, told: UNSENT };
        let feed = feeds.get(q.table);
        if (!feed) feeds.set(q.table, (feed = new Feed(q.table)));
        feed.add(sub);
        return () => feed.remove(sub);
      } catch (err) {
        queueMicrotask(() => report(error, wrap(err) as AnyDbError));
        return () => {};
      }
    },
    explain: () => summarize(ready().plan),
  };
}

/** The row a document becomes: itself, or the fields `select` names. */
function rowOf({ ir }: Compiled, doc: JsonDoc): unknown {
  if (!ir.select) return doc;
  const row: Record<string, unknown> = {};
  for (const [name, path] of Object.entries(ir.select)) row[name] = valueAt(doc, path);
  return row;
}

/** What a run yields: rows, one row, or a number. */
function valueOf(q: Compiled, found: Found): unknown {
  if (found.count !== undefined) return found.count;
  const rows = found.docs.map((doc) => rowOf(q, doc));
  return q.ir.shape === "one" ? rows[0] : rows;
}

/**
 * What a subscription keeps of its last run: what the dirty rule and row
 * identity read. The rows are the ones its subscriber holds. A patch moves
 * `seq`, `value` and `list` on, so a result is the subscription's own.
 */
type Result = {
  /** A change at or below this seq is in the result. */
  seq: number;
  /** The rows handed out, in order. A count has none. For a query of rows, `value` is this array. */
  list: unknown[];
  /** The same rows by document id. */
  readonly byId: Map<string, unknown>;
  /** The order fields of the last row, copied from its stored document, when the result holds `limit` rows: every match after it is outside the result. */
  readonly last: JsonDoc | undefined;
  value: unknown;
};

/**
 * How a subscription follows the feed without a read, when its result can be
 * kept exactly from the changes. Every other query reads again when a change
 * may alter it.
 *
 * - `count`: no offset or limit, on an exact plan over a key-only index.
 *   Its count is the entries in the plan's ranges, and each change says the
 *   entries it added and removed.
 * - `rows`: no offset or limit. The result is every document that passes
 *   `where` and that the plan reads, so a change decides on its own whether
 *   its document is in the result. `key` places a row: the query's order, in
 *   the names of the rows when `select` renames the fields.
 */
type Patch = { readonly kind: "count" } | { readonly kind: "rows"; readonly key: OrderKey };

type Subscription = {
  readonly q: Compiled;
  readonly patch: Patch | undefined;
  readonly next: (value: unknown) => void;
  readonly error: ((error: AnyDbError) => void) | undefined;
  /** Undefined until the first read. */
  result: Result | undefined;
  /** The last value `next` got. */
  told: unknown;
};

function call(listener: () => void): void {
  try {
    listener();
  } catch (err) {
    console.error("@opfs-lsm/db: a subscriber threw", err);
  }
}

function report(listener: Subscription["error"], error: AnyDbError): void {
  if (listener) call(() => listener(error));
  else if (!(error instanceof ClosedError)) console.error("@opfs-lsm/db: a subscription with no error callback ended", error);
}

/** A row that orders as the document of an index entry does, for the fields the index holds. */
function entryRow(by: readonly string[], entry: { readonly id: string; readonly values: readonly Scalar[] }): unknown {
  const row: Record<string, unknown> = Object.create(null);
  by.forEach((field, i) => {
    const path = field.split(".");
    let at = row;
    for (const segment of path.slice(0, -1)) at = (at[segment] ??= Object.create(null)) as Record<string, unknown>;
    at[path.at(-1)!] = entry.values[i];
  });
  row["id"] = entry.id;
  return row;
}

/**
 * Whether `change` may alter the result `r` of `q`, which holds every
 * change up to `r.seq`. Never false when the result changes. True more often
 * than needed is allowed: it costs a read.
 *
 * Let d be the changed document, M the documents that pass `where`, in the
 * query's order, and R the result, a window of M. Every document has one
 * entry in the plan's index (the write gate), and the plan's ranges hold the
 * entry of every document of M (plan.ts). So when the change can tell d's
 * entry before it, an entry outside the ranges, or none, means d was not in
 * M before. A change can tell for a sorted index whose entries are their key.
 *
 * - A plan by ids: only a change to one of those ids matters.
 * - A count changes when d enters or leaves M. On an exact plan the ranges
 *   are M, so d was in M iff its entry was in them, and it is in M after iff
 *   it passes `where`: dirty iff the two differ. On any other plan: dirty if
 *   d passes `where` after, or may have been in M before.
 * - Rows. 1: d is in R: dirty. 2: d passes `where` after, and R is not full
 *   or d sorts at or before R's last row: dirty, since d enters R or the rows
 *   before it. 3: otherwise d is neither in R nor about to be. With no
 *   offset R is the start of M, so before the change d was after R's last
 *   row or outside M: clean. With an offset d may have been among the rows
 *   passed over, and leaving them shifts R: dirty when d may have been in M
 *   before, at or before R's last row when the entry tells its place.
 *
 * A clean change leaves the result as it was, so the next change is tested
 * against the state it applies to.
 */
function dirties({ ir, plan, where, order }: Compiled, r: Result, change: DocChange<JsonDoc>): boolean {
  if (plan.kind === "none") return false;
  if (plan.kind === "ids") return plan.ids.includes(change.id);
  const after = change.doc;
  const passes = after !== undefined && where(after);
  const { index } = plan;
  /** The entries d had in the plan's ranges, or undefined when the change cannot tell. */
  const before = () => {
    if (!keyOnly(index?.info)) return undefined;
    try {
      const entries: { id: string; values: Scalar[] }[] = change.before(index!.name as never);
      return entries.filter((e) => entryInRanges(plan, e.values));
    } catch {
      // The catalog moved under the change.
      return undefined;
    }
  };
  if (ir.shape === "count") {
    const was = before();
    return was && plan.exact ? was.length > 0 !== passes : passes || !was || was.length > 0;
  }
  if (r.byId.has(change.id)) return true;
  if (passes && (!r.last || compareRows(after, r.last, order) <= 0)) return true;
  if (ir.offset === 0) return false;
  const was = before();
  if (!was) return true;
  // An entry tells where d was only when it holds every field of the order.
  const { last } = r;
  const placed = last && order.paths.every((path) => [...index!.info.by, "id"].includes(dotPath(path)!));
  return was.some((e) => !placed || compareRows(entryRow(index!.info.by, e), last, order) <= 0);
}

function patchOf({ ir, plan, order }: Compiled): Patch | undefined {
  if (ir.offset !== 0 || ir.limit !== undefined || ir.shape === "one") return undefined;
  if (ir.shape === "count") return plan.kind === "ranges" && plan.exact && keyOnly(plan.index?.info) ? { kind: "count" } : undefined;
  // A text index holds only the words it was cut into: whether it holds a document is not in the document alone.
  if (plan.kind === "none" || (plan.kind === "ranges" && plan.index?.info.text !== undefined)) return undefined;
  if (!ir.select) return { kind: "rows", key: order };
  // A row is placed by its own fields, so `select` must hold every field of the order.
  const names = order.paths.map((path) => Object.entries(ir.select!).find(([, from]) => from.join("\0") === path.join("\0"))?.[0]);
  return names.every((name) => name !== undefined) ? { kind: "rows", key: { paths: names.map((name) => [name!]), desc: order.desc } } : undefined;
}

/**
 * Whether a run reads `doc`. `where` is the whole predicate. Every range of
 * the plan is implied by it, so a document that passes it is in them once it
 * has an entry, and an index has one for a document with a value at each
 * field it orders by.
 */
function reads({ plan, where }: Compiled, doc: JsonDoc): boolean {
  if (!where(doc)) return false;
  if (plan.kind !== "ranges") return plan.kind === "ids" && plan.ids.includes(doc.id);
  return !plan.index || plan.index.info.by.every((field) => fieldAt(doc, field.split(".")) !== undefined);
}

/** The place of `row` in `list`, which is in the order of `key`: the first row not before it. */
function placeOf(list: readonly unknown[], row: unknown, key: OrderKey): number {
  let [from, to] = [0, list.length];
  while (from < to) {
    const mid = (from + to) >> 1;
    if (compareRows(list[mid], row, key) < 0) from = mid + 1;
    else to = mid;
  }
  return from;
}

/**
 * Move the result of `sub` to the state after `changes`, or say it cannot.
 * What is left of a patch that fails is rerun, since a read replaces it.
 *
 * A count moves by the entries each change added to the plan's ranges less
 * those it removed. A write records an entry only when it changed it, and a
 * key-only entry is its key, so the entries it records are the difference of
 * the counts.
 *
 * Rows: a document is in the result after its change iff `reads` it, and was
 * in it before iff the result holds its id. The result stays in order since
 * each row goes where the order puts it, `id` last.
 */
function patch(sub: Subscription, r: Result, changes: readonly DocChange<JsonDoc>[]): boolean {
  const { q } = sub;
  const how = sub.patch!;
  if (how.kind === "count") {
    const { plan } = q as Compiled & { plan: Extract<Compiled["plan"], { kind: "ranges" }> };
    const index = plan.index!.name as never;
    let delta = 0;
    for (const change of changes) {
      const { added, removed } = change.written(index);
      for (const e of added) if (entryInRanges(plan, e.values)) delta++;
      for (const e of removed) if (entryInRanges(plan, e.values)) delta--;
    }
    if (delta !== 0) r.value = (r.value as number) + delta;
    return true;
  }
  const { key } = how;
  for (const change of changes) {
    const { doc } = change;
    const row = doc !== undefined && reads(q, doc) ? rowOf(q, doc) : undefined;
    const old = r.byId.get(change.id);
    if (old === undefined ? row === undefined : row !== undefined && sameJson(old, row)) continue;
    // What the subscriber holds is not changed: a patch works on a copy.
    if (r.list === sub.told) r.value = r.list = r.list.slice();
    if (old !== undefined) {
      const at = placeOf(r.list, old, key);
      if (r.list[at] !== old) return false;
      r.list.splice(at, 1);
      r.byId.delete(change.id);
    }
    if (row !== undefined) {
      r.list.splice(placeOf(r.list, row, key), 0, row);
      r.byId.set(change.id, row);
    }
  }
  return true;
}

type Change = Exclude<CollectionChange<JsonDoc>, { kind: "closed" }>;

/** The feed of each collection's subscriptions, while it has any. */
const feeds = new WeakMap<Table, Feed>();

class Failure {
  constructor(readonly error: unknown) {}
}

/**
 * The subscriptions of one collection of one database. It owns the only
 * `changes` listener of the collection and the only read in flight.
 *
 * It listens before its first read, and a result keeps the seq of its
 * snapshot, so no change falls between a read and the changes tested
 * against it. Dirty subscriptions read together in one snapshot, once per
 * microtask batch. While a read is in flight, changes are held, then tested
 * against the new results: writes faster than reads become one more read,
 * not a queue of them. A `closed` event is never held: it ends every
 * subscription at once, with the reason the storage gives.
 */
class Feed {
  private readonly subs = new Set<Subscription>();
  private readonly dirty = new Set<Subscription>();
  /** Subscriptions a patch moved on: they hear of it in the next flush, once. */
  private readonly patched = new Set<Subscription>();
  private held: Change[] | undefined;
  private scheduled = false;
  private readonly off: () => void;

  constructor(private readonly table: Table) {
    this.off = table.docs.changes((event) => {
      if (event.kind === "closed") this.end(new ClosedError(event.reason === "destroyed" ? "destroyed" : "closed"));
      else if (this.held) this.held.push(event);
      else this.apply(event);
    });
  }

  add(sub: Subscription): void {
    this.subs.add(sub);
    this.dirty.add(sub);
    this.schedule();
  }

  remove(sub: Subscription): void {
    this.dirty.delete(sub);
    this.patched.delete(sub);
    if (!this.subs.delete(sub) || this.subs.size > 0) return;
    this.off();
    if (feeds.get(this.table) === this) feeds.delete(this.table);
  }

  private end(error: AnyDbError): void {
    for (const sub of [...this.subs]) this.fail(sub, error);
  }

  private fail(sub: Subscription, error: AnyDbError): void {
    this.remove(sub);
    report(sub.error, error);
  }

  private apply(event: Change): void {
    for (const sub of this.subs) {
      const r = sub.result;
      if (!r || this.dirty.has(sub)) continue;
      if (event.kind === "gap") this.dirty.add(sub);
      else if (event.seq > r.seq) {
        try {
          if (!sub.patch) {
            if (event.changes.some((change) => dirties(sub.q, r, change))) this.dirty.add(sub);
          } else if (follows(sub, r, event)) this.patched.add(sub);
          else this.dirty.add(sub);
        } catch {
          // A change that cannot be read, such as a document that is no JSON object: a read says, and ends the subscription if it fails too.
          this.dirty.add(sub);
        }
      }
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled || this.held || (this.dirty.size === 0 && this.patched.size === 0)) return;
    this.scheduled = true;
    queueMicrotask(() => void this.flush());
  }

  private async flush(): Promise<void> {
    this.scheduled = false;
    const batch = [...this.dirty];
    // A dirty subscription hears of its patches in the result of its read.
    for (const sub of this.patched) if (!this.dirty.has(sub)) release(sub);
    this.patched.clear();
    this.dirty.clear();
    if (batch.length === 0) return;
    this.held = [];
    const pending = new Set(batch);
    // One failed read ends its own subscription only.
    const done = (sub: Subscription, result: Found | Failure) => {
      if (!pending.delete(sub) || !this.subs.has(sub)) return;
      if (result instanceof Failure) this.fail(sub, wrap(result.error) as AnyDbError);
      else settle(sub, result);
    };
    const read = (snap: Parameters<typeof execute>[0], subs: Subscription[]) =>
      Promise.all(subs.map((sub) => execute(snap, sub.q).then((found) => done(sub, found), (err: unknown) => done(sub, new Failure(err)))));
    try {
      // Each result is handed over as soon as it is read, all from one snapshot. A count reads every match, so
      // the rows are read first and never wait for one.
      await this.table.docs.view(async (snap) => {
        await read(snap, batch.filter((sub) => sub.q.ir.shape !== "count"));
        await read(snap, batch.filter((sub) => sub.q.ir.shape === "count"));
      });
    } catch (err) {
      for (const sub of [...pending]) done(sub, new Failure(err));
    }
    const held = this.held;
    this.held = undefined;
    for (const event of held) this.apply(event);
    this.schedule();
  }
}

/** Patch `r` with the changes of `event`: true when it holds them all now. */
function follows(sub: Subscription, r: Result, event: Extract<Change, { kind: "append" }>): boolean {
  try {
    if (!patch(sub, r, event.changes)) return false;
  } catch {
    // The catalog moved under a change, or a document cannot be read: a read says.
    return false;
  }
  r.seq = event.seq;
  return true;
}

/**
 * Hand a patched result to the subscriber. A list of the same length that
 * differs from the one it holds in a few rows, which are equal to them (a
 * document deleted and written again), is that list.
 */
function release(sub: Subscription): void {
  const r = sub.result!;
  const { told, patch } = sub;
  if (patch?.kind === "rows" && r.value === r.list && r.list !== told && Array.isArray(told) && told.length === r.list.length) {
    const apart: number[] = [];
    for (let i = 0; i < told.length && apart.length <= 8; i++) if (r.list[i] !== told[i]) apart.push(i);
    if (apart.length <= 8 && apart.every((i) => sameJson(r.list[i], told[i]))) {
      for (const i of apart) r.byId.set(valueAt(told[i], patch.key.paths.at(-1)!) as string, told[i]);
      r.value = r.list = told;
    }
  }
  tell(sub, r.value);
}

/** Hand `value` to the subscriber, unless it holds it. */
function tell(sub: Subscription, value: unknown): void {
  if (value === sub.told) return;
  sub.told = value;
  call(() => sub.next(value));
}

const NO_ROWS: unknown[] = [];
const UNSENT = Symbol("unsent");

/**
 * Keep a run's result on `sub`, and call `next` if the value changed.
 *
 * A row equal to the row the last result held at its place, or for its
 * document, is handed out as that same object. When every row is the one at
 * its place, the value is the same array and `next` is not called. The place
 * comes first: without the id in `select`, two documents can give equal
 * rows. Equality is compared, since a
 * change that the new snapshot already holds may still be on its way, so
 * the changes seen so far cannot say which rows stayed the same.
 */
function settle(sub: Subscription, found: Found): void {
  const { q, result: prev } = sub;
  const { limit, shape } = q.ir;
  let list = NO_ROWS;
  const byId = new Map<string, unknown>();
  let value: unknown = found.count;
  if (found.count === undefined) {
    list = [];
    // The rows the subscriber holds, which a patch not yet handed over is ahead of.
    const olds = prev && (shape === "rows" ? (sub.told as unknown[]) : prev.list);
    let same = olds?.length === found.docs.length;
    found.docs.forEach((doc, i) => {
      const row = rowOf(q, doc);
      const at = olds?.[i];
      const old = prev?.byId.get(doc.id);
      const kept = at !== undefined && sameJson(at, row) ? at : old !== undefined && sameJson(old, row) ? old : row;
      byId.set(doc.id, kept);
      list.push(kept);
      if (kept !== at) same = false;
    });
    if (same) list = olds!;
    value = shape === "one" ? list[0] : list;
  }
  const end = found.docs.length === limit ? found.docs.at(-1) : undefined;
  const last = end && orderFields(end, q.order);
  sub.result = { seq: found.seq, list, byId, last, value };
  tell(sub, value);
}

/** The fields of `doc` that `order` reads, copied: the subscriber holds `doc` itself, and may change it. */
function orderFields(doc: JsonDoc, order: OrderKey): JsonDoc {
  const out: Record<string, unknown> = Object.create(null);
  for (const path of order.paths) {
    let at = out;
    for (const key of path.slice(0, -1)) at = (at[key] ??= Object.create(null)) as Record<string, unknown>;
    at[path.at(-1)!] = valueAt(doc, path);
  }
  return out as JsonDoc;
}

/** Whether two JSON values are equal, whatever the order of their keys. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
