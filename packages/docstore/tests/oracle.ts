import type { QueryInput, Scalar } from "../src/schema.js";
import { compareCodePoints, compareScalar, compareTuple } from "./order.js";

/** An index as the oracle reads it, written from the schema rules rather than from the stored layout. */
export type ModelIndex =
  | { readonly kind: "unique"; readonly on: readonly string[] }
  | { readonly kind: "sorted" | "multi"; readonly on: readonly string[]; readonly include?: readonly string[] }
  | { readonly kind: "text"; readonly on: readonly string[]; readonly text: string };

type Doc = { readonly id: string; readonly [key: string]: unknown };
type Hit = { readonly id: string; readonly values: readonly Scalar[]; readonly doc: Doc };

export function stored<D>(doc: D): D {
  return JSON.parse(JSON.stringify(doc)) as D;
}

function at(doc: Doc, path: string): unknown {
  let v: unknown = doc;
  for (const k of path.split(".")) {
    if (typeof v !== "object" || v === null || Array.isArray(v) || !Object.hasOwn(v, k)) return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== "");
}

function entries(doc: Doc, ix: ModelIndex): Scalar[][] {
  const values = ix.on.map((p) => at(doc, p));
  if (values.some((v) => v === undefined)) return [];
  if (ix.kind === "text") {
    const text = at(doc, ix.text);
    if (text !== null && typeof text !== "string") return [];
  }
  const rest = values.slice(1) as Scalar[];
  if (ix.kind === "multi") {
    const first = Array.isArray(values[0]) ? (values[0] as Scalar[]) : [values[0] as Scalar];
    const distinct: Scalar[] = [];
    for (const v of first) if (!distinct.some((d) => compareScalar(d, v) === 0)) distinct.push(v);
    return distinct.map((v) => [v, ...rest]);
  }
  return [values as Scalar[]];
}

function indexOrder(docs: readonly Doc[], ix: ModelIndex): Hit[] {
  const hits = docs.flatMap((doc) => entries(doc, ix).map((values) => ({ id: doc.id, values, doc })));
  return hits.sort((a, b) => compareTuple(a.values, b.values) || compareCodePoints(a.id, b.id));
}

function inBound(v: Scalar, q: QueryInput): boolean {
  if (q.startsWith !== undefined) return typeof v === "string" && v.startsWith(q.startsWith);
  if (q.gt !== undefined && compareScalar(v, q.gt) <= 0) return false;
  if (q.gte !== undefined && compareScalar(v, q.gte) < 0) return false;
  if (q.lt !== undefined && compareScalar(v, q.lt) >= 0) return false;
  if (q.lte !== undefined && compareScalar(v, q.lte) > 0) return false;
  return true;
}

/**
 * What `query(q)` returns without `limit` and `after`: the ids, then the documents, in result order.
 * A slot of `eq` is a value or a list of them, and an entry stands for its document under one of
 * the combinations. The documents come in the order of the values after `eq`, then by id. An
 * entry equal to another there is one document under two combinations: it comes once, with the
 * entry of the smallest combination going forward and of the largest going back.
 */
export function expected(docs: readonly Doc[], ix: ModelIndex | undefined, q: QueryInput): Hit[] {
  const all = ix
    ? indexOrder(docs, ix)
    : [...docs].sort((a, b) => compareCodePoints(a.id, b.id)).map((doc) => ({ id: doc.id, values: [doc.id], doc }));
  const eq = q.eq ?? [];
  const words = q.match === undefined ? [] : wordsOf(q.match);
  const out = all.filter((h) => {
    if (eq.some((slot, i) => !(Array.isArray(slot) ? slot : [slot]).some((v) => compareScalar(h.values[i]!, v) === 0))) return false;
    if (eq.length < h.values.length && !inBound(h.values[eq.length]!, q)) return false;
    if (ix?.kind !== "text" || words.length === 0) return true;
    const have = wordsOf((at(h.doc, ix.text) as string | null) ?? "");
    return words.every((w) => have.some((word) => word.includes(w)));
  });
  const tail = (h: Hit) => h.values.slice(eq.length);
  const same = (a: Hit, b: Hit | undefined) => b !== undefined && a.id === b.id && compareTuple(tail(a), tail(b)) === 0;
  out.sort(
    (a, b) =>
      compareTuple(tail(a), tail(b)) || compareCodePoints(a.id, b.id) || compareTuple(a.values.slice(0, eq.length), b.values.slice(0, eq.length)),
  );
  const once = out.filter((h, i) => !same(h, out[i + (q.reverse ? 1 : -1)]));
  return q.reverse ? once.reverse() : once;
}
