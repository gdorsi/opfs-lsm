import type { IndexInfo, Scalar } from "@opfs-lsm/docstore";
import { and, type IR, type LoadSubsetOptions } from "@tanstack/db";

type BasicExpression<T = any> = IR.BasicExpression<T>;

/** One docstore query without its page fields: an index, the values of its first components, and one bound. */
export type DocstoreQuery = {
  readonly index: string;
  readonly eq: readonly Scalar[];
  readonly gt?: Scalar;
  readonly gte?: Scalar;
  readonly lt?: Scalar;
  readonly lte?: Scalar;
  readonly match?: string;
  readonly reverse?: boolean;
};

/**
 * TanStack's order of one path: values in index order, `reverse` for desc,
 * null and missing values first or last. Without `lexical`, strings compare
 * by a collation the index does not hold; other values still compare in
 * index order.
 */
export type Order = {
  readonly path: string;
  readonly reverse: boolean;
  readonly nulls: "first" | "last";
  readonly lexical: boolean;
};

/**
 * Where a read finds its rows. A plan may reach rows the `where` rejects,
 * never miss one it accepts: every row is filtered by the `where` after.
 *
 * - `ids`: the `where` pins `id`; read those documents.
 * - `ranges`: each query's rows. With `first`, only the first `limit` rows
 *   in `order` that pass the `where` are owed, so each range is read in
 *   pages until it has that many. If those rows hold a string the index
 *   cannot order, the ranges are read whole.
 * - `scan`: every document.
 */
export type Plan =
  | { readonly kind: "ids"; readonly ids: readonly string[] }
  | {
      readonly kind: "ranges";
      readonly ranges: readonly DocstoreQuery[];
      readonly first?: { readonly order: Order; readonly limit: number };
    }
  | { readonly kind: "scan" };

/** One read of a load: the rows `plan` reaches that pass `where`. */
export type Read = { readonly where: BasicExpression<boolean> | undefined; readonly plan: Plan };

/** Past this many ranges, an index pins fewer of its components. */
export const MAX_RANGES = 64;

/**
 * The reads that serve one `loadSubset` request. A request with a cursor is
 * two reads: the first `limit` rows after the cursor, and every row tied with
 * it. The cursor replaces the offset.
 */
export function planLoad(options: LoadSubsetOptions, indexes: ReadonlyMap<string, IndexInfo>): Read[] {
  const { where, orderBy, cursor } = options;
  const limit = options.limit === undefined ? undefined : options.limit + (cursor ? 0 : (options.offset ?? 0));
  if (!cursor) return [{ where, plan: planRead(where, orderBy?.[0], limit, indexes) }];
  const from = where ? and(where, cursor.whereFrom) : cursor.whereFrom;
  const current = where ? and(where, cursor.whereCurrent) : cursor.whereCurrent;
  return [
    { where: from, plan: planRead(from, orderBy?.[0], limit, indexes) },
    { where: current, plan: planRead(current, undefined, undefined, indexes) },
  ];
}

type Bound = { readonly value: Scalar; readonly inclusive: boolean };

/** What the top-level conjuncts of a `where` say about each dot path. Anything else is residual. */
type Facts = {
  /** eq and in: the values the path may hold. An empty list matches nothing. */
  readonly pins: Map<string, Scalar[]>;
  readonly lower: Map<string, Bound>;
  readonly upper: Map<string, Bound>;
  /** like and ilike: the words their patterns hold, per path. */
  readonly words: Map<string, string[]>;
};

function planRead(
  where: BasicExpression<boolean> | undefined,
  clause: IR.OrderByClause | undefined,
  limit: number | undefined,
  indexes: ReadonlyMap<string, IndexInfo>,
): Plan {
  const facts = factsOf(where);
  if ([...facts.pins.values()].some((values) => values.length === 0)) return { kind: "ranges", ranges: [] };
  const ids = facts.pins.get("id");
  if (ids) return { kind: "ids", ids: ids.filter((id): id is string => typeof id === "string") };
  const order = limit === undefined ? undefined : orderOf(clause);
  if (order && limit !== undefined) {
    if (limit === 0) return { kind: "ranges", ranges: [] };
    const ordered = orderedRanges(facts, order, indexes);
    if (ordered) return { kind: "ranges", ranges: ordered, first: { order, limit } };
  }
  return unorderedRanges(facts, indexes) ?? { kind: "scan" };
}

function orderOf(clause: IR.OrderByClause | undefined): Order | undefined {
  if (!clause) return undefined;
  const path = pathOf(clause.expression);
  const { direction, nulls, stringSort } = clause.compareOptions;
  if (path === undefined) return undefined;
  return { path, reverse: direction === "desc", nulls, lexical: stringSort === "lexical" };
}

/** The index paths that may be read: sorted and text indexes. A text index holds only documents with a string at `text`. */
function usable(info: IndexInfo, facts: Facts): boolean {
  if (info.kind === "sorted") return true;
  return info.kind === "text" && info.text !== undefined && facts.words.has(info.text);
}

function matchOf(info: IndexInfo, facts: Facts): string | undefined {
  const words = info.text === undefined ? undefined : facts.words.get(info.text);
  return words && words.length > 0 ? words.join(" ") : undefined;
}

/** How many leading components of `on` are pinned, keeping the product of their values within MAX_RANGES. */
function pinnedPrefix(on: readonly string[], facts: Facts, upTo: number): number {
  let k = 0;
  let product = 1;
  while (k < upTo) {
    const values = facts.pins.get(on[k]!);
    if (!values || product * values.length > MAX_RANGES) break;
    product *= values.length;
    k++;
  }
  return k;
}

function combos(on: readonly string[], k: number, facts: Facts): Scalar[][] {
  let out: Scalar[][] = [[]];
  for (let i = 0; i < k; i++) {
    const values = facts.pins.get(on[i]!)!;
    out = out.flatMap((prefix) => values.map((v) => [...prefix, v]));
  }
  return out;
}

type Choice = { readonly name: string; readonly info: IndexInfo; readonly k: number; readonly score: readonly number[] };

function best(choices: readonly Choice[]): Choice | undefined {
  let top: Choice | undefined;
  for (const c of choices) {
    if (!top || compareScores(c.score, top.score) > 0) top = c;
  }
  return top;
}

function compareScores(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

function boundsOn(path: string, facts: Facts): Pick<DocstoreQuery, "gt" | "gte" | "lt" | "lte"> {
  const lower = facts.lower.get(path);
  const upper = facts.upper.get(path);
  return {
    ...(lower && (lower.inclusive ? { gte: lower.value } : { gt: lower.value })),
    ...(upper && (upper.inclusive ? { lte: upper.value } : { lt: upper.value })),
  };
}

/**
 * An index whose `on` is [pinned paths..., order path, ...], with the
 * longest pinned prefix. One range per combination of pinned values (the
 * order path's own pins included), read in order and merged.
 *
 * The index puts null before every value. When TanStack wants nulls on the
 * other side, each range splits into its null rows and the rest, and the
 * merge puts them where TanStack does. A bound on the order path excludes
 * null rows, so it needs no split.
 */
function orderedRanges(facts: Facts, order: Order, indexes: ReadonlyMap<string, IndexInfo>): DocstoreQuery[] | undefined {
  const choices: Choice[] = [];
  for (const [name, info] of indexes) {
    if (!usable(info, facts)) continue;
    const at = info.on.indexOf(order.path);
    if (at < 0 || pinnedPrefix(info.on, facts, at) < at) continue;
    const own = facts.pins.get(order.path)?.length ?? 1;
    if (combos(info.on, at, facts).length * own > MAX_RANGES) continue;
    const match = matchOf(info, facts) === undefined ? 0 : 1;
    choices.push({ name, info, k: at, score: [at, match, info.kind === "sorted" ? 1 : 0, -info.on.length] });
  }
  const choice = best(choices);
  if (!choice) return undefined;
  const { name, info, k } = choice;
  const match = matchOf(info, facts);
  const base = (eq: readonly Scalar[]): DocstoreQuery => ({
    index: name,
    eq,
    ...(match !== undefined && { match }),
    ...(order.reverse && { reverse: true }),
  });
  const pinned = facts.pins.get(order.path);
  const bounds = boundsOn(order.path, facts);
  const bounded = Object.keys(bounds).length > 0;
  const nullsInIndexOrder = (order.nulls === "first") !== order.reverse;
  return combos(info.on, k, facts).flatMap((eq): DocstoreQuery[] => {
    if (pinned) return pinned.map((v) => base([...eq, v]));
    if (bounded) return [{ ...base(eq), ...bounds }];
    if (nullsInIndexOrder) return [base(eq)];
    return [base([...eq, null]), { ...base(eq), gt: null }];
  });
}

/** The index with the longest pinned prefix, then a bound on the next component, then a text match. */
function unorderedRanges(facts: Facts, indexes: ReadonlyMap<string, IndexInfo>): Plan | undefined {
  const choices: Choice[] = [];
  for (const [name, info] of indexes) {
    if (!usable(info, facts)) continue;
    const k = pinnedPrefix(info.on, facts, info.on.length);
    const next = info.on[k];
    const bounded = next !== undefined && (facts.lower.has(next) || facts.upper.has(next)) ? 1 : 0;
    const match = matchOf(info, facts) === undefined ? 0 : 1;
    if (k === 0 && !bounded && !match) continue;
    choices.push({ name, info, k, score: [k, bounded, match, info.kind === "sorted" ? 1 : 0, -info.on.length] });
  }
  const choice = best(choices);
  if (!choice) return undefined;
  const { name, info, k } = choice;
  const match = matchOf(info, facts);
  const next = info.on[k];
  const bounds = next === undefined ? {} : boundsOn(next, facts);
  const ranges = combos(info.on, k, facts).map(
    (eq): DocstoreQuery => ({ index: name, eq, ...bounds, ...(match !== undefined && { match }) }),
  );
  return { kind: "ranges", ranges };
}

const FLIP: Record<string, string> = { eq: "eq", gt: "lt", gte: "lte", lt: "gt", lte: "gte" };

function factsOf(where: BasicExpression<boolean> | undefined): Facts {
  const facts: Facts = { pins: new Map(), lower: new Map(), upper: new Map(), words: new Map() };
  for (const c of conjuncts(where)) {
    if (c.type !== "func" || c.args.length !== 2) continue;
    let [left, right] = c.args as [BasicExpression, BasicExpression];
    let name = c.name;
    if (left.type === "val" && right.type === "ref" && name in FLIP) {
      [left, right] = [right, left];
      name = FLIP[name]!;
    }
    const path = pathOf(left);
    if (path === undefined || right.type !== "val") continue;
    const value: unknown = right.value;
    switch (name) {
      case "eq":
        if (isScalar(value)) pin(facts, path, [value]);
        break;
      case "in":
        if (Array.isArray(value)) {
          const present = value.filter((v) => v !== null && v !== undefined);
          if (present.every(isScalar)) pin(facts, path, present);
        }
        break;
      case "gt":
      case "gte":
        if (isScalar(value) && !facts.lower.has(path)) facts.lower.set(path, { value, inclusive: name === "gte" });
        break;
      case "lt":
      case "lte":
        if (isScalar(value) && !facts.upper.has(path)) facts.upper.set(path, { value, inclusive: name === "lte" });
        break;
      case "like":
      case "ilike":
        if (typeof value === "string") facts.words.set(path, [...(facts.words.get(path) ?? []), ...wordsOf(value)]);
        break;
    }
  }
  return facts;
}

function pin(facts: Facts, path: string, values: readonly Scalar[]): void {
  const distinct = [...new Map(values.map((v) => [`${typeof v}:${String(v)}`, v])).values()];
  const had = facts.pins.get(path);
  facts.pins.set(path, had ? had.filter((v) => distinct.some((w) => w === v)) : distinct);
}

export function conjuncts(where: BasicExpression<boolean> | undefined): BasicExpression<boolean>[] {
  if (!where) return [];
  if (where.type === "func" && where.name === "and") return where.args.flatMap((a) => conjuncts(a));
  return [where];
}

/**
 * The dot path of a property ref, or undefined for anything an index cannot
 * name: other expressions, TanStack's virtual `$` properties, and segments
 * holding a dot.
 */
function pathOf(expression: BasicExpression): string | undefined {
  if (expression.type !== "ref") return undefined;
  const { path, sourceAlias } = expression;
  const own = sourceAlias !== undefined && path[0] === sourceAlias ? path.slice(1) : path;
  if (own.length === 0 || own.some((s) => s.includes(".")) || own[0]!.startsWith("$")) return undefined;
  return own.join(".");
}

/** A value docstore can put in an index key, and that a TanStack comparison does not treat as unknown. */
function isScalar(v: unknown): v is Scalar {
  if (typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  return typeof v === "string" && v.isWellFormed();
}

const NON_WORD = /[^\p{L}\p{M}\p{N}]+/u;

/** docstore's text words. Each word of a like pattern occurs inside one word of every text the pattern matches. */
function wordsOf(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .split(NON_WORD)
    .filter((w) => w !== "");
}
