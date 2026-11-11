import type { Cursor, JsonDoc } from "@opfs-lsm/docstore";
import type { DocstoreQuery, Order, Plan } from "./plan.js";

/** What a read needs of a docstore snapshot. */
export interface Snapshot {
  query(q: object): Promise<{ readonly docs: JsonDoc[]; readonly next?: Cursor }>;
  getMany(ids: readonly string[]): Promise<(JsonDoc | undefined)[]>;
}

/**
 * The leading order value of the last row a limited read returned. Every
 * row that passes the `where` and sorts at or before it is loaded.
 */
export type Boundary = { readonly order: Order; readonly value: unknown };

export type Found = { readonly docs: readonly JsonDoc[]; readonly boundary?: Boundary };

const FIRST_PAGE = 16;
const LAST_PAGE = 4096;

export async function read(snap: Snapshot, plan: Plan, match: (doc: JsonDoc) => boolean): Promise<Found> {
  switch (plan.kind) {
    case "ids":
      return { docs: (await snap.getMany(plan.ids)).filter((d): d is JsonDoc => d !== undefined && match(d)) };
    case "scan":
      return { docs: (await snap.query({})).docs.filter(match) };
    case "ranges": {
      const { first } = plan;
      if (!first) {
        const pages = await Promise.all(plan.ranges.map((q) => snap.query(q)));
        return { docs: pages.flatMap((p) => p.docs.filter(match)) };
      }
      const { order, limit } = first;
      const parts = await Promise.all(plan.ranges.map((q) => firstMatches(snap, q, match, limit)));
      const docs = parts.flat().sort((a, b) => compareRows(a, b, order)).slice(0, limit);
      if (!order.lexical && docs.some((d) => typeof valueAt(d, order.path) === "string")) {
        return read(snap, { kind: "ranges", ranges: plan.ranges }, match);
      }
      if (docs.length < limit) return { docs };
      return { docs, boundary: { order, value: valueAt(docs[limit - 1]!, order.path) } };
    }
  }
}

/** The first `want` rows of one range that pass `match`, read in pages that grow while few rows pass. */
async function firstMatches(snap: Snapshot, q: DocstoreQuery, match: (doc: JsonDoc) => boolean, want: number) {
  const out: JsonDoc[] = [];
  let after: Cursor | undefined;
  let size = Math.max(want, FIRST_PAGE);
  for (;;) {
    const page = await snap.query({ ...q, limit: size, ...(after !== undefined && { after }) });
    for (const doc of page.docs) {
      if (!match(doc)) continue;
      out.push(doc);
      if (out.length === want) return out;
    }
    if (page.next === undefined) return out;
    after = page.next;
    size = Math.min(size * 2, LAST_PAGE);
  }
}

/** The boundary a limited read would set if `docs` were every row that passes its `where`. */
export function boundaryOf(docs: readonly JsonDoc[], { order, limit }: { readonly order: Order; readonly limit: number }): Boundary | undefined {
  if (docs.length < limit) return undefined;
  if (!order.lexical && docs.some((d) => typeof valueAt(d, order.path) === "string")) return undefined;
  const sorted = docs.toSorted((a, b) => compareRows(a, b, order));
  return { order, value: valueAt(sorted[limit - 1]!, order.path) };
}

export function atOrBefore(doc: JsonDoc, boundary: Boundary): boolean {
  return compareOrder(valueAt(doc, boundary.order.path), boundary.value, boundary.order) <= 0;
}

function compareRows(a: JsonDoc, b: JsonDoc, order: Order): number {
  return compareOrder(valueAt(a, order.path), valueAt(b, order.path), order) || compareStrings(a.id, b.id);
}

/** TanStack's placement of null and missing values, and the index's order for the rest. */
function compareOrder(x: unknown, y: unknown, order: Order): number {
  const xNull = x === null || x === undefined;
  const yNull = y === null || y === undefined;
  if (xNull || yNull) {
    if (xNull && yNull) return 0;
    return (xNull ? -1 : 1) * (order.nulls === "first" ? 1 : -1);
  }
  const c = compareValues(x, y);
  return order.reverse ? -c : c;
}

const RANK: Record<string, number> = { boolean: 1, number: 2, string: 3 };

/** docstore's index order: false < true < numbers < strings by code point. */
function compareValues(x: unknown, y: unknown): number {
  const rx = RANK[typeof x] ?? 4;
  const ry = RANK[typeof y] ?? 4;
  if (rx !== ry) return rx - ry;
  if (typeof x === "string") return compareStrings(x, y as string);
  if (typeof x === "number" || typeof x === "boolean") return Number(x) - Number(y);
  return 0;
}

/** Code point order, which is UTF-8 byte order. Plain `<` compares UTF-16 units, which differs past U+FFFF. */
function compareStrings(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    if (x >= 0xd800 && y >= 0xd800) {
      x += x >= 0xe000 ? -0x800 : 0x2000;
      y += y >= 0xe000 ? -0x800 : 0x2000;
    }
    return x - y;
  }
  return a.length - b.length;
}

/** The value at a dot path, read as docstore reads an index path: own properties of objects only. */
function valueAt(doc: JsonDoc, path: string): unknown {
  let v: unknown = doc;
  for (const segment of path.split(".")) {
    if (typeof v !== "object" || v === null || Array.isArray(v) || !Object.hasOwn(v, segment)) return undefined;
    v = (v as Record<string, unknown>)[segment];
  }
  return v;
}
