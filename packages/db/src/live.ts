/*
 * `query`: a query bound to its database, with one-shot runs.
 */
import { IR, root, type Buildable, type QueryRoot } from "./builder.js";
import { tableOf } from "./database.js";
import { ClosedError, wrap } from "./errors.js";
import { execute, type Compiled, type Found } from "./execute.js";
import { compile, orderKeyOf, valueAt } from "./expr.js";
import { planQuery, summarize, type PlanSummary } from "./plan.js";
import type { JsonDoc } from "./schema.js";

/** A query bound to its database. Building one reads nothing. */
export interface LiveQuery<V> {
  /** One read, from one snapshot. Rejects with a DbError. */
  run(): Promise<V>;
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
  return {
    async run() {
      try {
        const q = ready();
        if (q.table.owner.closed) throw new ClosedError("closed");
        return valueOf(q, await q.table.docs.view((snap) => execute(snap, q))) as V;
      } catch (err) {
        throw wrap(err);
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
