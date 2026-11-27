/*
 * TanStack DB's builder syntax over our own query description. A builder is
 * immutable: each method returns a new one, so a base query can be shared
 * and extended into a page and its count.
 */
import type { Collection } from "./database.js";
import { QueryError } from "./errors.js";
import { conditionOf, nodeOf, refProxy, type Condition, type Expression, type Node, type Ref, type Refs, type Scalar } from "./expr.js";
import type { JsonDoc } from "./schema.js";

/**
 * A whole query, as data. A ref names the alias of its source, so a join
 * adds a list of sources next to `from` and no new kind of node.
 */
export type QueryIR = {
  readonly from: { readonly alias: string; readonly collection: unknown };
  /** Each `where` call adds one. A row passes when all hold. */
  readonly where: readonly Node[];
  readonly orderBy: readonly { readonly path: readonly string[]; readonly desc: boolean }[];
  readonly offset: number;
  readonly limit: number | undefined;
  /** The path of each output field. Undefined: the document itself. */
  readonly select: Readonly<Record<string, readonly string[]>> | undefined;
  readonly shape: "rows" | "one" | "count";
};

declare const resultType: unique symbol;
export const IR: unique symbol = Symbol("ir");

/** What `query` takes: a builder, or the result of its `findOne` or `count`. `V` is what a run yields. */
export interface Buildable<V> {
  readonly [resultType]?: V;
  readonly [IR]: QueryIR;
}

/** The `q` of `query((q) => ...)`. */
export interface QueryRoot {
  /** The collection to read, under the alias its fields go by: `from({ i: issues })`. */
  from<const A extends string, T extends JsonDoc>(source: { readonly [K in A]: Collection<T, any> }): QueryBuilder<{ readonly [K in A]: T }, T>;
}

type ValueOf<R> = R extends Expression<infer V> ? V : never;

/** `S` maps each alias to its document type. `Row` is one row of the result. */
export interface QueryBuilder<S, Row> extends Buildable<readonly Row[]> {
  /** Keep the rows where the condition holds. Several calls must all hold. */
  where(condition: (refs: Refs<S>) => Condition): QueryBuilder<S, Row>;
  /** Order by a field. Chain it for more fields. Rows that tie come in `id` order. */
  orderBy(field: (refs: Refs<S>) => Ref<Scalar>, direction?: "asc" | "desc"): QueryBuilder<S, Row>;
  limit(n: number): QueryBuilder<S, Row>;
  offset(n: number): QueryBuilder<S, Row>;
  /** Give each row these fields only: `select(({ i }) => ({ id: i.id, title: i.title }))`. */
  select<P extends Record<string, Ref<unknown>>>(fields: (refs: Refs<S>) => P): QueryBuilder<S, { readonly [K in keyof P]: ValueOf<P[K]> }>;
  /** The first row, or undefined. */
  findOne(): Buildable<Row | undefined>;
  /** How many rows the query yields, after `offset` and `limit`. */
  count(): Buildable<number>;
}

/** The one implementation, typed loosely: the interfaces above carry the types an app sees. */
class Builder {
  readonly [IR]: QueryIR;

  constructor(ir: QueryIR) {
    this[IR] = ir;
  }

  private with(change: Partial<QueryIR>): Builder {
    return new Builder({ ...this[IR], ...change });
  }

  private refs(): never {
    const { alias } = this[IR].from;
    return { [alias]: refProxy(alias) } as never;
  }

  /** The path of a field of this query's source. The types ask for one, and a cast can lie. */
  private path(e: Expression<unknown>, least: number): readonly string[] {
    const node = nodeOf(e);
    if (node.kind !== "ref" || node.alias !== this[IR].from.alias || node.path.length < least) {
      throw new QueryError("operand", "orderBy and select take fields of the query's collection");
    }
    return node.path;
  }

  where(condition: (refs: never) => Condition): Builder {
    return this.with({ where: [...this[IR].where, conditionOf(condition(this.refs()))] });
  }

  orderBy(field: (refs: never) => Ref<Scalar>, direction: "asc" | "desc" = "asc"): Builder {
    return this.with({ orderBy: [...this[IR].orderBy, { path: this.path(field(this.refs()), 1), desc: direction === "desc" }] });
  }

  limit(n: number): Builder {
    return this.with({ limit: count(n, "limit") });
  }

  offset(n: number): Builder {
    return this.with({ offset: count(n, "offset") });
  }

  select(fields: (refs: never) => Record<string, Ref<unknown>>): Builder {
    const select: Record<string, readonly string[]> = {};
    for (const [name, field] of Object.entries(fields(this.refs()))) select[name] = this.path(field, 0);
    return this.with({ select });
  }

  findOne(): Buildable<never> {
    return { [IR]: { ...this[IR], limit: 1, shape: "one" } };
  }

  count(): Buildable<number> {
    return { [IR]: { ...this[IR], shape: "count" } };
  }
}

/** A mistake in the code that builds the query, so not a DbError. */
function count(n: number, what: string): number {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`${what} takes an integer of at least 0`);
  return n;
}

export const root: QueryRoot = {
  from(source: Record<string, unknown>) {
    const entries = Object.entries(source);
    if (entries.length !== 1) throw new QueryError("source", "from takes one collection: joins are not supported yet");
    const [alias, collection] = entries[0]!;
    return new Builder({ from: { alias, collection }, where: [], orderBy: [], offset: 0, limit: undefined, select: undefined, shape: "rows" }) as never;
  },
};
