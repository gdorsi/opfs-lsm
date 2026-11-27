/*
 * From a query to docstore reads. Pure: the query and the collection's
 * indexes in, a Plan out.
 *
 * What the rest of the package relies on:
 * - A plan reaches every document the `where` accepts. Every document has an
 *   entry in every sorted and text index (the write gate requires their
 *   fields), and each range is implied by the conjuncts it came from.
 * - `exact`: the plan reaches only documents the `where` accepts.
 * - `ordered`: the plan yields documents in the query's order.
 */
import type { IndexInfo } from "@opfs-lsm/docstore";
import { compareValues, normalized, type Node, type OrderKey, type Scalar } from "./expr.js";
import { isId } from "./schema.js";

/** One docstore query, less its page fields. A slot of `eq` holds a list when the field may have several values. */
export type DocQuery = {
  readonly index?: string;
  readonly eq?: readonly (Scalar | readonly Scalar[])[];
  readonly gt?: Scalar;
  readonly gte?: Scalar;
  readonly lt?: Scalar;
  readonly lte?: Scalar;
  readonly match?: string;
  readonly reverse?: true;
};

/**
 * Where a run finds its rows.
 *
 * - `none`: no document can pass the `where`, or the limit is 0.
 * - `ids`: the `where` names the ids. Those rows are read, then filtered and sorted.
 * - `ranges`: `ranges` are read one after the other on `index`. Without an
 *   index they read the rows in id order, which is how a scan is expressed.
 */
export type Plan =
  | { readonly kind: "none" }
  | { readonly kind: "ids"; readonly ids: readonly string[] }
  | {
      readonly kind: "ranges";
      readonly index: string | undefined;
      readonly info: IndexInfo | undefined;
      readonly ranges: readonly DocQuery[];
      readonly ordered: boolean;
      readonly exact: boolean;
    };

/** How a query reads, as `explain()` shows it. */
export type PlanSummary =
  | { readonly kind: "none" | "ids" }
  | { readonly kind: "index"; readonly index: string; readonly ranges: number; readonly ordered: boolean; readonly exact: boolean }
  | { readonly kind: "scan"; readonly ordered: boolean; readonly exact: boolean };

/** docstore reads at most this many combinations of listed values in one query. Past it, an index pins fewer fields. */
const MAX_RANGES = 64;
/** docstore refuses a query whose key passes 8 KiB. A string this short stays under it on an index of 8 fields. */
const MAX_STRING_UNITS = 256;

type Type = "boolean" | "number" | "string";
type Bound = { readonly value: Scalar; readonly inclusive: boolean };
/** The values of one type between two bounds. */
type Band = { readonly type: Type; readonly lower?: Bound; readonly upper?: Bound; readonly from: readonly number[] };
type Pin = { readonly values: readonly Scalar[]; readonly from: readonly number[] };

/** What the conjuncts say about each field, by dot path. `from` names the conjuncts a fact stands for. */
type Facts = {
  /** eq, inArray, and an `or` of them on one field: the values it may hold. */
  readonly pins: Map<string, Pin>;
  /** gt, gte, lt, lte. */
  readonly bands: Map<string, Band>;
  /** like and ilike: their patterns' words, as the `match` of a text index. */
  readonly words: Map<string, string>;
  readonly conjuncts: number;
  /** No document can pass. */
  readonly empty: boolean;
};

const same = (a: unknown, b: unknown): boolean => compareValues(a, b) === 0;

/** A value an index key can hold, and a query can name. */
function indexable(v: unknown): v is Scalar {
  if (v === null || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  return typeof v === "string" && v.length <= MAX_STRING_UNITS && v.isWellFormed();
}

/** The dot path of a field of `alias`, as an index names it. A segment that holds a dot has none. */
export function dotPath(path: readonly string[]): string | undefined {
  return path.length === 0 || path.some((s) => s === "" || s.includes(".")) ? undefined : path.join(".");
}

function pathOf(node: Node | undefined, alias: string): string | undefined {
  return node?.kind === "ref" && node.alias === alias ? dotPath(node.path) : undefined;
}

function distinct(values: readonly Scalar[]): Scalar[] {
  const sorted = values.toSorted(compareValues);
  return sorted.filter((v, i) => i === 0 || !same(v, sorted[i - 1]));
}

/** The field a conjunct pins and the values it allows, when that is all it says. An id may be any scalar: one no document has reads nothing. */
function pinOf(node: Node, alias: string): { readonly path: string; readonly values: Scalar[] } | undefined {
  if (node.kind !== "fn") return undefined;
  const [a, b] = node.args;
  const pin = (ref: Node | undefined, values: unknown) => {
    const path = pathOf(ref, alias);
    if (path === undefined || !Array.isArray(values)) return undefined;
    const ok = path === "id" ? values.every((v) => v === null || ["boolean", "number", "string"].includes(typeof v)) : values.every(indexable);
    return ok ? { path, values: distinct(values as Scalar[]) } : undefined;
  };
  switch (node.name) {
    case "eq":
      return a?.kind === "val" ? pin(b, [a.value]) : b?.kind === "val" ? pin(a, [b.value]) : undefined;
    case "in":
      return b?.kind === "val" ? pin(a, b.value) : undefined;
    case "or": {
      const arms = node.args.map((arm) => pinOf(arm, alias));
      const path = arms[0]?.path;
      if (!arms.every((arm) => arm !== undefined && arm.path === path)) return undefined;
      return { path: path!, values: distinct(arms.flatMap((arm) => arm!.values)) };
    }
    default:
      return undefined;
  }
}

const FLIP = { gt: "lt", gte: "lte", lt: "gt", lte: "gte" } as const;

/** `band` with one more bound: the tighter of the two on that side. */
function tighten(band: Band, side: "lower" | "upper", next: Bound, from: number): Band {
  const had = band[side];
  const c = had ? compareValues(next.value, had.value) * (side === "lower" ? 1 : -1) : 1;
  const bound = c > 0 || (c === 0 && !next.inclusive) ? next : had!;
  return { ...band, [side]: bound, from: [...band.from, from] };
}

const flatten = (node: Node): Node[] => (node.kind === "fn" && node.name === "and" ? node.args.flatMap(flatten) : [node]);

function factsOf(where: readonly Node[], alias: string): Facts {
  const conjuncts = where.flatMap(flatten);
  const pins = new Map<string, Pin>();
  const bands = new Map<string, Band>();
  const words = new Map<string, string>();
  let empty = false;
  conjuncts.forEach((c, i) => {
    const pinned = pinOf(c, alias);
    if (pinned) {
      const had = pins.get(pinned.path);
      const values = had ? pinned.values.filter((v) => had.values.some((w) => same(v, w))) : pinned.values;
      pins.set(pinned.path, { values, from: [...(had?.from ?? []), i] });
      return;
    }
    if (c.kind !== "fn") return;
    let [left, right] = c.args;
    let name = c.name;
    if (name === "like" || name === "ilike") {
      const path = pathOf(left, alias);
      if (path === undefined || right?.kind !== "val" || typeof right.value !== "string") return;
      // Each run of letters of the pattern lies inside one word of any text it matches, in the form the index stores. docstore cuts the words itself.
      words.set(path, `${words.get(path) ?? ""} ${normalized(right.value)}`);
      return;
    }
    if (!(name in FLIP)) return;
    if (left?.kind === "val") {
      [left, right] = [right, left];
      name = FLIP[name as keyof typeof FLIP];
    }
    const path = pathOf(left, alias);
    if (path === undefined || right?.kind !== "val") return;
    const value = right.value;
    // A comparison with null holds for nothing.
    if (value === null || value === undefined) empty = true;
    if (value === null || !indexable(value)) return;
    const type = typeof value as Type;
    const had = bands.get(path) ?? { type, from: [] };
    // Two types on one field, or an id that is no string, hold for nothing.
    if (had.type !== type || (path === "id" && type !== "string")) empty = true;
    else bands.set(path, tighten(had, name === "gt" || name === "gte" ? "lower" : "upper", { value, inclusive: name === "gte" || name === "lte" }, i));
  });
  for (const { lower, upper } of bands.values()) {
    const c = lower && upper ? compareValues(lower.value, upper.value) : -1;
    if (c > 0 || (c === 0 && !(lower!.inclusive && upper!.inclusive))) empty = true;
  }
  if ([...pins.values()].some((pin) => pin.values.length === 0)) empty = true;
  return { pins, bands, words, conjuncts: conjuncts.length, empty };
}

/**
 * A band as an index range. An index holds every type in one order, so a
 * side the query leaves open ends where the type does: numbers lie between
 * `true` and the empty string.
 */
function boundsOf({ type, lower, upper }: Band): Pick<DocQuery, "gt" | "gte" | "lt" | "lte"> {
  const from: Bound = lower ?? (type === "number" ? { value: true, inclusive: false } : { value: type === "string" ? "" : false, inclusive: true });
  const to: Bound | undefined = upper ?? (type === "number" ? { value: "", inclusive: false } : type === "boolean" ? { value: true, inclusive: true } : undefined);
  return { [from.inclusive ? "gte" : "gt"]: from.value, ...(to && { [to.inclusive ? "lte" : "lt"]: to.value }) };
}

const HAS_WORD = /[\p{L}\p{M}\p{N}]/u;

type Candidate = Extract<Plan, { kind: "ranges" }> & { readonly score: readonly number[] };

/**
 * How `by` (an index's fields, or `["id"]` for the rows) would serve the query.
 *
 * The first k fields that the `where` pins become `eq`, and a band on the
 * next field becomes the bound. Within one docstore query, a pinned field is
 * constant when it has one value, and when it has several docstore merges
 * their entries by the fields after `eq`, then id. So a query yields the
 * order (fields after `eq`, id). It is the order of the rows when the order
 * fields, less those pinned to one value, are those fields. When the order
 * starts with pinned fields of several values, their values split into one
 * query per combination, read in the order of the combinations.
 */
function candidate(name: string | undefined, info: IndexInfo | undefined, facts: Facts, order: OrderKey, wantsFirst: boolean): Candidate | undefined {
  const by = info ? info.by : ["id"];
  const { pins, bands } = facts;
  let k = 0;
  for (let product = 1; info && k < by.length; k++) {
    const values = pins.get(by[k]!)?.values.length;
    if (values === undefined || (info.unique && values > 1) || product * values > MAX_RANGES) break;
    product *= values;
  }
  const pinned = by.slice(0, k);
  const bound = k < by.length ? bands.get(by[k]!) : undefined;
  const words = info?.text === undefined ? undefined : facts.words.get(info.text);
  const match = words !== undefined && HAS_WORD.test(words) ? words : undefined;

  const constant = (field: string) => pins.get(field)?.values.length === 1;
  // `id` ends every order, and nothing after an `id` in the index orders anything.
  const wanted = order.paths.slice(0, -1).map(dotPath);
  const fields = wanted.filter((f) => f === undefined || !constant(f));
  const split = fields.filter((f) => f !== undefined && pinned.includes(f)) as string[];
  const rest = by.slice(k);
  const yields = (rest.includes("id") ? rest.slice(0, rest.indexOf("id")) : rest).filter((f) => !constant(f));
  const desc = order.desc[0]!;
  const ordered = order.desc.every((d) => d === desc) && fields.length === split.length + yields.length && fields.every((f, i) => f === [...split, ...yields][i]);

  const consumed = new Set([...pinned.flatMap((f) => pins.get(f)!.from), ...(bound?.from ?? [])]);
  const exact = consumed.size === facts.conjuncts;
  if (info && k === 0 && !bound && match === undefined && !ordered) return undefined;

  // One query per combination of the values the order starts with, in that order. Every other pinned field keeps its list.
  let combos: Map<string, Scalar>[] = [new Map()];
  for (const f of ordered ? split : []) combos = combos.flatMap((c) => pins.get(f)!.values.map((v) => new Map(c).set(f, v)));
  if (desc) combos.reverse();
  const ranges = combos.map((combo): DocQuery => {
    const eq = pinned.map((f) => {
      const { values } = pins.get(f)!;
      return combo.has(f) ? combo.get(f)! : values.length === 1 ? values[0]! : values;
    });
    return {
      ...(name !== undefined && { index: name }),
      ...(k > 0 && { eq }),
      ...(bound && boundsOf(bound)),
      ...(match !== undefined && { match }),
      ...(desc && ordered && { reverse: true as const }),
    };
  });
  const n = [k, bound ? 1 : 0, match === undefined ? 0 : 1];
  const score = wantsFirst ? [+ordered, +exact, ...n, -by.length] : [+exact, ...n, +ordered, -by.length];
  return { kind: "ranges", index: name, info, ranges, ordered, exact, score };
}

/** What the planner reads of a query. */
type Planned = {
  readonly from: { readonly alias: string };
  readonly where: readonly Node[];
  readonly limit: number | undefined;
  readonly shape: "rows" | "one" | "count";
};

/**
 * The plan of a query whose rows come in `order`. With a limit, an index
 * that yields the order comes first, since the read then stops early. A
 * count and a query with no limit read every match, so the index that
 * reaches the fewest other rows comes first. A multi index is never read:
 * it holds a document once per element.
 */
export function planQuery(query: Planned, order: OrderKey, indexes: ReadonlyMap<string, IndexInfo>): Plan {
  const facts = factsOf(query.where, query.from.alias);
  if (facts.empty || query.limit === 0) return { kind: "none" };
  const ids = facts.pins.get("id");
  if (ids) return { kind: "ids", ids: ids.values.filter(isId) };
  const wantsFirst = query.limit !== undefined && query.shape !== "count";
  let best = candidate(undefined, undefined, facts, order, wantsFirst)!;
  for (const [name, info] of indexes) {
    const c = info.kind === "multi" ? undefined : candidate(name, info, facts, order, wantsFirst);
    if (c && higher(c.score, best.score)) best = c;
  }
  const { score: _, ...plan } = best;
  return plan;
}

function higher(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

export function summarize(plan: Plan): PlanSummary {
  if (plan.kind !== "ranges") return { kind: plan.kind };
  const { index, ordered, exact } = plan;
  return index === undefined ? { kind: "scan", ordered, exact } : { kind: "index", index, ranges: plan.ranges.length, ordered, exact };
}

/**
 * Whether an index entry with these values lies in one of the plan's
 * ranges. A `match` is not checked: it can only narrow a range.
 */
export function entryInRanges(plan: Extract<Plan, { kind: "ranges" }>, values: readonly Scalar[]): boolean {
  return plan.ranges.some(({ eq = [], gt, gte, lt, lte }) => {
    const v = values[eq.length];
    return (
      eq.every((slot, i) => (Array.isArray(slot) ? slot.some((s) => same(s, values[i])) : same(slot, values[i]))) &&
      (gt === undefined || compareValues(v, gt) > 0) &&
      (gte === undefined || compareValues(v, gte) >= 0) &&
      (lt === undefined || compareValues(v, lt) < 0) &&
      (lte === undefined || compareValues(v, lte) <= 0)
    );
  });
}

/** Whether a change can tell the entries a document had in this index: docstore's `before` reads only an index whose entries are their key. */
export function keyOnly(info: IndexInfo | undefined): info is IndexInfo {
  return info !== undefined && info.kind === "sorted" && !info.unique && info.include === undefined;
}
