/*
 * The expression tree, the operators that build it, and the one definition of
 * what it means: value order, comparison, and the filter and the order of
 * rows. The planner maps these onto index ranges, the executor filters and
 * sorts with them, and the live rule compares with them, so the three cannot
 * disagree.
 */
import { QueryError } from "./errors.js";

/** What a comparison and an index component hold. A missing field reads as null. */
export type Scalar = null | boolean | number | string;

/** A field of one source. `alias` names the source, `i` in `from({ i: issues })`. */
export type RefNode = { readonly kind: "ref"; readonly alias: string; readonly path: readonly string[] };
export type ValNode = { readonly kind: "val"; readonly value: unknown };
export type FnName = "eq" | "gt" | "gte" | "lt" | "lte" | "in" | "like" | "ilike" | "and" | "or" | "not";
export type FnNode = { readonly kind: "fn"; readonly name: FnName; readonly args: readonly Node[] };
export type Node = RefNode | ValNode | FnNode;

declare const valueType: unique symbol;
declare const refBrand: unique symbol;
const NODE: unique symbol = Symbol("node");

/** An expression whose value has type `V`. */
export interface Expression<V> {
  readonly [valueType]?: V;
  readonly [NODE]: Node;
}

/**
 * A field of a document. An object field is also the record of its own
 * fields' refs. An array field is a leaf. An optional field reads as
 * `V | null`, and so does every field under an optional or nullable object.
 */
export type Ref<V> = Expression<V> & { readonly [refBrand]: true } & ([NonNullable<V>] extends [readonly unknown[]]
    ? unknown
    : [NonNullable<V>] extends [object]
      ? { readonly [K in keyof NonNullable<V> & string]-?: Ref<FieldValue<NonNullable<V>[K]> | Extract<V, null>> }
      : unknown);
type FieldValue<F> = undefined extends F ? Exclude<F, undefined> | null : F;

/** What a builder callback receives: one ref per source alias. */
export type Refs<S> = { readonly [A in keyof S]: Ref<S[A]> };

type Operand<V> = Expression<V> | V;
type Comparable = Exclude<Scalar, null>;

/** Records each property read as one more segment of the path. */
export function refProxy(alias: string, path: readonly string[] = []): Ref<unknown> {
  const node: RefNode = { kind: "ref", alias, path };
  return new Proxy({}, { get: (_, key) => (key === NODE ? node : typeof key === "string" ? refProxy(alias, [...path, key]) : undefined) }) as Ref<unknown>;
}

function isExpression(x: unknown): x is Expression<unknown> {
  return typeof x === "object" && x !== null && (x as { [NODE]?: Node })[NODE] !== undefined;
}

export function nodeOf(e: Expression<unknown>): Node {
  if (!isExpression(e)) throw new QueryError("operand", "expected a field or an expression built by an operator");
  return e[NODE];
}

/** What `where`, `and`, `or` and `not` take: an operator's result, or a boolean field, where a missing or null one is false. */
export type Condition = Expression<boolean | null>;

/** The node of a condition. A boolean field alone means `eq(field, true)`. */
export function conditionOf(e: Condition): Node {
  const node = nodeOf(e);
  return node.kind === "ref" ? { kind: "fn", name: "eq", args: [node, { kind: "val", value: true }] } : node;
}

const operand = (x: unknown): Node => (isExpression(x) ? x[NODE] : { kind: "val", value: x });
const fn = (name: FnName, args: readonly Node[]) => ({ [NODE]: { kind: "fn", name, args } }) as Expression<boolean>;
const compare = (name: FnName) => (left: unknown, right: unknown) => fn(name, [operand(left), operand(right)]);

type Compare = {
  <V extends Comparable>(left: Expression<V | null>, right: NoInfer<Expression<V | null> | V>): Expression<boolean>;
  <V extends Comparable>(left: V, right: Expression<V | null>): Expression<boolean>;
};

/** True for two equal values, null included: `eq(i.due, null)` holds for a missing or null `due`. */
export function eq<V extends Scalar>(left: Expression<V>, right: NoInfer<Operand<V>>): Expression<boolean>;
export function eq<V extends Scalar>(left: V, right: Expression<V>): Expression<boolean>;
export function eq(left: unknown, right: unknown): Expression<boolean> {
  return fn("eq", [operand(left), operand(right)]);
}
/** `gt`, `gte`, `lt` and `lte` compare two booleans, two numbers or two strings. Any other pair, one with null included, is false. */
export const gt: Compare = compare("gt");
export const gte: Compare = compare("gte");
export const lt: Compare = compare("lt");
export const lte: Compare = compare("lte");

export function inArray<V extends Scalar>(value: Expression<V>, list: readonly NoInfer<V>[]): Expression<boolean> {
  return fn("in", [nodeOf(value), { kind: "val", value: list }]);
}

/** SQL LIKE: `%` is any run of characters and `_` is one. Case-sensitive. Both sides are compared in Unicode NFC. */
export function like(value: Expression<string | null>, pattern: string): Expression<boolean> {
  return fn("like", [nodeOf(value), { kind: "val", value: pattern }]);
}

/** As `like`, with both sides in lower case. */
export function ilike(value: Expression<string | null>, pattern: string): Expression<boolean> {
  return fn("ilike", [nodeOf(value), { kind: "val", value: pattern }]);
}

type Conditions = readonly [Condition, Condition, ...Condition[]];

export function and(...all: Conditions): Expression<boolean> {
  return fn("and", all.map(conditionOf));
}

export function or(...any: Conditions): Expression<boolean> {
  return fn("or", any.map(conditionOf));
}

export function not(condition: Condition): Expression<boolean> {
  return fn("not", [conditionOf(condition)]);
}

/** The value at a path, as docstore reads an index path: own properties of plain objects only. Undefined when the field is missing. */
export function fieldAt(doc: unknown, path: readonly string[]): unknown {
  let v = doc;
  for (const segment of path) {
    if (typeof v !== "object" || v === null || Array.isArray(v) || !Object.hasOwn(v, segment)) return undefined;
    v = (v as Record<string, unknown>)[segment];
  }
  return v;
}

/** As `fieldAt`, with a missing field read as null. */
export function valueAt(doc: unknown, path: readonly string[]): unknown {
  return fieldAt(doc, path) ?? null;
}

/** The types of the index order, lowest first, with their least and greatest values where they have one. */
const BANDS: readonly { readonly type: string; readonly least?: Scalar; readonly greatest?: Scalar }[] = [
  { type: "null", least: null, greatest: null },
  { type: "boolean", least: false, greatest: true },
  { type: "number" },
  { type: "string", least: "" },
];
const RANK: Record<string, number> = Object.fromEntries(BANDS.map((band, i) => [band.type, i]));
const rank = (v: unknown): number => (v === null || v === undefined ? 0 : (RANK[typeof v] ?? BANDS.length));

/**
 * The order of the indexes: the types in `BANDS` order, booleans and numbers
 * by value, strings by code point, -0 equal to 0. Arrays and objects come
 * after strings and tie with each other.
 */
export function compareValues(a: unknown, b: unknown): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === "string") return compareStrings(a, b as string);
  return typeof a === "boolean" || typeof a === "number" ? Number(a) - Number(b) : 0;
}

export type Bound = { readonly value: Scalar; readonly inclusive: boolean };

/** Where the values of `type` lie in the index order: from its least value or past the type before, to its greatest or short of the type after. */
export function extentOf(type: "boolean" | "number" | "string"): { readonly lower: Bound; readonly upper: Bound | undefined } {
  const i = RANK[type]!;
  const { least, greatest } = BANDS[i]!;
  const next = BANDS[i + 1]?.least;
  return {
    lower: least !== undefined ? { value: least, inclusive: true } : { value: BANDS[i - 1]!.greatest!, inclusive: false },
    upper: greatest !== undefined ? { value: greatest, inclusive: true } : next !== undefined ? { value: next, inclusive: false } : undefined,
  };
}

/** Code point order, which is UTF-8 byte order. `<` compares UTF-16 units, which differs past U+FFFF. */
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

const equal = (a: unknown, b: unknown): boolean => rank(a) < 4 && compareValues(a, b) === 0;
/** Two booleans, two numbers or two strings: the pairs `gt`, `gte`, `lt` and `lte` compare. */
const sameBand = (a: unknown, b: unknown): boolean => typeof a === typeof b && typeof a in RANK;

const COMPARE: Partial<Record<FnName, (a: unknown, b: unknown) => boolean>> = {
  eq: equal,
  gt: (a, b) => sameBand(a, b) && compareValues(a, b) > 0,
  gte: (a, b) => sameBand(a, b) && compareValues(a, b) >= 0,
  lt: (a, b) => sameBand(a, b) && compareValues(a, b) < 0,
  lte: (a, b) => sameBand(a, b) && compareValues(a, b) <= 0,
};

/** The text `like` compares. A text index stores the same form, lowercased, so its words stand for the words of a pattern. */
export const normalized = (text: string): string => text.normalize("NFC");
/** The text `ilike` compares: docstore's form of the words of a text index, with a final sigma as any other. */
const folded = (text: string): string => normalized(text).toLowerCase().replaceAll("ς", "σ");

function likeTest(pattern: unknown, fold: (text: string) => string): (value: unknown) => boolean {
  if (typeof pattern !== "string") throw new QueryError("operand", "like takes a string pattern");
  let source = "";
  for (const ch of fold(pattern)) source += ch === "%" ? "[^]*" : ch === "_" ? "[^]" : ch.replace(/[\\^$.*+?()[\]{}|]/, "\\$&");
  const re = new RegExp(`^${source}$`, "u");
  return (value) => typeof value === "string" && re.test(fold(value));
}

/** The order of a query's rows: its fields, each ascending or descending, with `id` last so that no two rows tie. */
export type OrderKey = { readonly paths: readonly (readonly string[])[]; readonly desc: readonly boolean[] };

const isId = (path: readonly string[]) => path.length === 1 && path[0] === "id";

/** `id` follows the `orderBy` fields in the direction of the last one. A field after `id`, or named twice, orders nothing. */
export function orderKeyOf(orderBy: readonly { readonly path: readonly string[]; readonly desc: boolean }[]): OrderKey {
  const paths: (readonly string[])[] = [];
  const desc: boolean[] = [];
  for (const { path, desc: d } of orderBy) {
    if (paths.some((p) => p.join(".") === path.join("."))) continue;
    paths.push(path);
    desc.push(d);
    if (isId(path)) return { paths, desc };
  }
  return { paths: [...paths, ["id"]], desc: [...desc, desc.at(-1) ?? false] };
}

/** The order of two rows under `key`. Zero only for two rows of one id. */
export function compareRows(a: unknown, b: unknown, key: OrderKey): number {
  for (let i = 0; i < key.paths.length; i++) {
    const c = compareValues(valueAt(a, key.paths[i]!), valueAt(b, key.paths[i]!));
    if (c !== 0) return key.desc[i] ? -c : c;
  }
  return 0;
}

export type Predicate = (doc: unknown) => boolean;

/**
 * The filter of the rows of `alias`: true when every conjunct holds. Each
 * expression is true or false, never unknown, so `not` is plain negation.
 */
export function compile(conjuncts: readonly Node[], alias: string): Predicate {
  const value = (node: Node | undefined): ((doc: unknown) => unknown) => {
    if (node?.kind === "val") return () => node.value;
    if (node?.kind !== "ref") throw new QueryError("operand", "an operator takes fields and values");
    if (node.alias !== alias) throw new QueryError("source", `"${node.alias}" is not a source of this query`);
    return (doc) => valueAt(doc, node.path);
  };
  const test = (node: Node): Predicate => {
    if (node.kind !== "fn") throw new QueryError("operand", "where takes a condition");
    const { name, args } = node;
    switch (name) {
      case "and":
      case "or": {
        const tests = args.map(test);
        return name === "and" ? (doc) => tests.every((t) => t(doc)) : (doc) => tests.some((t) => t(doc));
      }
      case "not": {
        const t = test(args[0]!);
        return (doc) => !t(doc);
      }
      case "in": {
        const left = value(args[0]);
        const list = value(args[1])(undefined);
        if (!Array.isArray(list)) throw new QueryError("operand", "inArray takes a list of values");
        return (doc) => {
          const v = left(doc);
          return list.some((x) => equal(v, x));
        };
      }
      case "like":
      case "ilike": {
        const left = value(args[0]);
        const matches = likeTest(value(args[1])(undefined), name === "like" ? normalized : folded);
        return (doc) => matches(left(doc));
      }
      default: {
        const left = value(args[0]);
        const right = value(args[1]);
        const holds = COMPARE[name]!;
        return (doc) => holds(left(doc), right(doc));
      }
    }
  };
  const tests = conjuncts.map(test);
  return (doc) => tests.every((t) => t(doc));
}
