/*
 * `query`: one-shot runs, subscriptions, the rule that says when a change may
 * alter a result, the batching of reruns, and row identity.
 */
import type { CollectionChange, DocChange } from "@opfs-lsm/docstore";
import { IR, root, type Buildable, type QueryRoot } from "./builder.js";
import { tableOf, type Table } from "./database.js";
import { ClosedError, wrap, type AnyDbError } from "./errors.js";
import { execute, type Compiled, type Found } from "./execute.js";
import { compareRows, compile, orderKeyOf, valueAt, type OrderKey, type Scalar } from "./expr.js";
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
        const sub: Subscription = { q, next: next as (value: unknown) => void, error, result: undefined };
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

/** What a subscription keeps of its last run: what the dirty rule and row identity read. The rows are the ones its subscriber holds. */
type Result = {
  /** A change at or below this seq is in the result. */
  readonly seq: number;
  /** The rows handed out, by document id, in order. A count has none. */
  readonly rows: ReadonlyMap<string, unknown>;
  /** The order fields of the last row, copied from its stored document, when the result holds `limit` rows: every match after it is outside the result. */
  readonly last: JsonDoc | undefined;
  readonly value: unknown;
};

type Subscription = {
  readonly q: Compiled;
  readonly next: (value: unknown) => void;
  readonly error: ((error: AnyDbError) => void) | undefined;
  /** Undefined until the first read. */
  result: Result | undefined;
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
  if (r.rows.has(change.id)) return true;
  if (passes && (!r.last || compareRows(after, r.last, order) <= 0)) return true;
  if (ir.offset === 0) return false;
  const was = before();
  if (!was) return true;
  // An entry tells where d was only when it holds every field of the order.
  const { last } = r;
  const placed = last && order.paths.every((path) => [...index!.info.by, "id"].includes(dotPath(path)!));
  return was.some((e) => !placed || compareRows(entryRow(index!.info.by, e), last, order) <= 0);
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
      let hit: boolean;
      try {
        hit = event.kind === "gap" || (event.seq > r.seq && event.changes.some((change) => dirties(sub.q, r, change)));
      } catch {
        // A change that cannot be read, such as a document that is no JSON object: a read says, and ends the subscription if it fails too.
        hit = true;
      }
      if (hit) this.dirty.add(sub);
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled || this.held || this.dirty.size === 0) return;
    this.scheduled = true;
    queueMicrotask(() => void this.flush());
  }

  private async flush(): Promise<void> {
    this.scheduled = false;
    const batch = [...this.dirty];
    this.dirty.clear();
    if (batch.length === 0) return;
    this.held = [];
    let found: (Found | Failure)[];
    try {
      // One failed read ends its own subscription only.
      found = await this.table.docs.view((snap) => Promise.all(batch.map((sub) => execute(snap, sub.q).catch((err: unknown) => new Failure(err)))));
    } catch (err) {
      found = batch.map(() => new Failure(err));
    }
    batch.forEach((sub, i) => {
      if (!this.subs.has(sub)) return;
      const result = found[i]!;
      if (result instanceof Failure) this.fail(sub, wrap(result.error) as AnyDbError);
      else settle(sub, result);
    });
    const held = this.held;
    this.held = undefined;
    for (const event of held) this.apply(event);
    this.schedule();
  }
}

const NO_ROWS: ReadonlyMap<string, unknown> = new Map();

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
  let rows = NO_ROWS;
  let value: unknown = found.count;
  if (found.count === undefined) {
    const next = new Map<string, unknown>();
    const olds = prev?.rows.values();
    let same = prev?.rows.size === found.docs.length;
    for (const doc of found.docs) {
      const row = rowOf(q, doc);
      const at = olds?.next().value;
      const old = prev?.rows.get(doc.id);
      const kept = at !== undefined && sameJson(at, row) ? at : old !== undefined && sameJson(old, row) ? old : row;
      next.set(doc.id, kept);
      if (kept !== at) same = false;
    }
    rows = next;
    value = shape === "one" ? next.values().next().value : same ? prev!.value : [...next.values()];
  }
  const end = found.docs.length === limit ? found.docs.at(-1) : undefined;
  const last = end && orderFields(end, q.order);
  sub.result = { seq: found.seq, rows, last, value };
  if (!prev || value !== prev.value) call(() => sub.next(value));
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
