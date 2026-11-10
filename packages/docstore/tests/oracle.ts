import type { QueryInput, Scalar } from "../src/schema.js";
import { compareCodePoints, compareScalar, compareTuple } from "./order.js";

/** An index as the oracle reads it, written from the schema rules rather than from the stored layout. */
export type ModelIndex =
  | { readonly kind: "sorted" | "unique"; readonly on: readonly string[] }
  | { readonly kind: "multi"; readonly on: readonly string[] }
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
  if (ix.kind === "text" && typeof at(doc, ix.text) !== "string") return [];
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

/** What `query(q)` returns without `limit` and `after`: the ids, then the documents, in result order. */
export function expected(docs: readonly Doc[], ix: ModelIndex | undefined, q: QueryInput): Hit[] {
  const all = ix
    ? indexOrder(docs, ix)
    : [...docs].sort((a, b) => compareCodePoints(a.id, b.id)).map((doc) => ({ id: doc.id, values: [doc.id], doc }));
  const eq = q.eq ?? [];
  const words = q.match === undefined ? [] : wordsOf(q.match);
  const out = all.filter((h) => {
    if (eq.some((v, i) => compareScalar(h.values[i]!, v) !== 0)) return false;
    if (eq.length < h.values.length && !inBound(h.values[eq.length]!, q)) return false;
    if (ix?.kind !== "text" || words.length === 0) return true;
    const have = wordsOf(at(h.doc, ix.text) as string);
    return words.every((w) => have.some((word) => word.includes(w)));
  });
  return q.reverse ? out.reverse() : out;
}
