/**
 * The results tables of docs/benchmarks.md, generated from the runs under
 * docs/results/. The page holds each table between `<!-- bench:table <id> -->`
 * and `<!-- /bench:table -->`, and bench/docs-tables.ts says what every table
 * reads. A cell is the median of one `Series` and a ratio comes from
 * `versus`, so a published number is one that `compare` sees too. A series of
 * fewer than `ENOUGH_RUNS` runs is refused, so no ratio is of sides that
 * `versus` cannot separate, and so is a table that reads a workload and
 * contender with a failed run.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SEED, type RunRecord, type SizeName } from "../core/types.ts";
import { describe, ENOUGH_RUNS, LEVEL, measure, versus, type Measures, type Metric, type Series } from "./metrics.ts";
import { readRecords } from "./records.ts";

const DOCS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs");
const RESULTS_DIR = path.join(DOCS_DIR, "results");
export const PAGE = path.join(DOCS_DIR, "benchmarks.md");

/**
 * Runs published before a table had to come from a clean tree. Every table
 * has been republished since, so it is empty, and none is ever added.
 */
export const LEGACY_DIRTY: ReadonlySet<string> = new Set([]);

/** Where a value is read: a contender, with the workload when the row or the table does not name it. */
type Cell = { readonly workload?: string; readonly contender: string };
type ValueColumn = { readonly head: string; readonly at: string | Cell };
type RatioColumn = { readonly head: string; readonly ratio: { readonly of: string; readonly over: string } };
type Column = { readonly head: string } | ValueColumn | RatioColumn;

type Row = {
  /** One text per label column, in order. */
  readonly label: string | readonly string[];
  readonly workload?: string;
  readonly phase: string;
  /** A pair prints "a / b" in each value cell and in each ratio cell. */
  readonly metric: Metric | readonly [Metric, Metric];
  /** Where this row reads a value column, by its head, instead of the column's own address. */
  readonly at?: Readonly<Record<string, string | Cell>>;
  /** The unit of a rate, replacing "ops/s"; null prints the bare number. */
  readonly unit?: string | null;
};

export type Table = {
  /** The marker name in docs/benchmarks.md. */
  readonly id: string;
  /** A stamp under docs/results/, without extension. */
  readonly file: string;
  readonly size?: SizeName;
  readonly workload?: string;
  readonly unit?: string | null;
  readonly columns: readonly Column[];
  readonly rows: readonly Row[];
};

export type Published = {
  readonly measures: Measures;
  readonly runs: readonly Pick<RunRecord, "workload" | "contender" | "size" | "host">[];
  /** The runs that ended in an error. They feed no series, and a table that reads their workload and contender is refused. */
  readonly failed: readonly Pick<RunRecord, "workload" | "contender" | "size" | "error">[];
};

/**
 * docs/results/<stamp>.jsonl. Throws when a run has uncommitted changes in its
 * tree, unless the stamp is in LEGACY_DIRTY, when a run overrode a kv
 * option, and when a run used a seed other than the default: the page
 * publishes what an app gets by default, on the inputs the budgets hold for.
 * A failed run is kept apart in `failed`.
 */
export function readPublished(stamp: string, dir = RESULTS_DIR): Published {
  const all = readRecords(path.join(dir, `${stamp}.jsonl`));
  const dirty = all.find((r) => r.host.gitSha.endsWith("-dirty"));
  if (dirty && !LEGACY_DIRTY.has(stamp)) {
    throw new Error(`${stamp}: a run recorded ${dirty.host.gitSha}, a tree with uncommitted changes. Publish a run from a clean tree.`);
  }
  const records = all.filter((r) => !r.error);
  const measures = measure(records);
  if (measures.kvOptions.length > 0) {
    throw new Error(`${stamp}: a run opened kv with ${measures.kvOptions[0]}. Publish a run with kv's default options.`);
  }
  const seed = measures.seeds.find((s) => s !== DEFAULT_SEED);
  if (seed !== undefined) throw new Error(`${stamp}: a run used seed ${seed}. Publish a run on the default seed ${DEFAULT_SEED}.`);
  return { measures, runs: records, failed: all.filter((r) => r.error) };
}

const BLOCK = /<!-- bench:table (\S+) -->\n([\s\S]*?)<!-- \/bench:table -->/g;

/** The page with every table rewritten between its markers. Text outside the markers is untouched. */
export function renderDocs(page: string, tables: readonly Table[], read: (stamp: string) => Published): string {
  return splice(page, tables, read).page;
}

/** The ids of the tables whose text between the markers differs from what the runs generate. */
export function staleTables(page: string, tables: readonly Table[], read: (stamp: string) => Published): string[] {
  return splice(page, tables, read).stale;
}

function splice(page: string, tables: readonly Table[], read: (stamp: string) => Published) {
  const opens = page.match(/<!-- bench:table /g)?.length ?? 0;
  const closes = page.match(/<!-- \/bench:table -->/g)?.length ?? 0;
  const ids = [...page.matchAll(BLOCK)].map((m) => m[1]!);
  if (opens !== closes || ids.length !== opens) {
    throw new Error(`${opens} opening and ${closes} closing bench:table markers do not pair up`);
  }
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice) throw new Error(`the marker "${twice}" appears twice`);
  for (const id of ids) {
    if (!tables.some((t) => t.id === id)) throw new Error(`the marker "${id}" has no table in bench/docs-tables.ts`);
  }
  for (const t of tables) {
    if (!ids.includes(t.id)) throw new Error(`the table "${t.id}" has no marker in the page`);
  }

  const files = new Map<string, Published>();
  const published = (stamp: string) => files.get(stamp) ?? files.set(stamp, read(stamp)).get(stamp)!;
  const stale: string[] = [];
  const next = page.replace(BLOCK, (block, id: string) => {
    const t = tables.find((t) => t.id === id)!;
    const text = `<!-- bench:table ${id} -->\n${renderTable(t, published(t.file))}\n<!-- /bench:table -->`;
    if (text !== block) stale.push(id);
    return text;
  });
  return { page: next, stale };
}

const isValue = (c: Column): c is ValueColumn => "at" in c;
const isRatio = (c: Column): c is RatioColumn => "ratio" in c;
const isLabel = (c: Column) => !isValue(c) && !isRatio(c);
const labelOf = (row: Row) => (typeof row.label === "string" ? [row.label] : row.label);
const metricsOf = (row: Row): readonly Metric[] => (typeof row.metric === "string" ? [row.metric] : row.metric);

function renderTable(t: Table, pub: Published): string {
  const size = t.size ?? "small";
  if (!pub.runs.some((r) => r.size === size)) {
    throw new Error(`${t.file} has no record of size "${size}", which the table "${t.id}" reads`);
  }
  const used = new Set<Series>();
  let unseparated = false;
  let clustered = false;

  const valueColumn = (head: string) => {
    const col = t.columns.find((c): c is ValueColumn => c.head === head && isValue(c));
    if (!col) throw new Error(`the table "${t.id}" has no value column "${head}"`);
    return col;
  };

  const lookup = (row: Row, col: ValueColumn, metric: Metric): Series => {
    const at = row.at?.[col.head] ?? col.at;
    const cell = typeof at === "string" ? { contender: at } : at;
    const workload = cell.workload ?? row.workload ?? t.workload;
    const where = `the table "${t.id}", row "${labelOf(row).join(" / ")}", column "${col.head}"`;
    if (!workload) throw new Error(`${where}: no workload`);
    const failed = pub.failed.find((r) => r.workload === workload && r.size === size && r.contender === cell.contender);
    if (failed) {
      throw new Error(`${where}: ${t.file} has a failed run of ${workload} ${cell.contender} (${failed.error!.split("\n")[0]}), so its medians are of the runs that survived. Publish a run without failures.`);
    }
    const s = pub.measures.get({ workload, size, contender: cell.contender, phase: row.phase, metric });
    if (!s) throw new Error(`${where}: ${t.file} has no series ${workload} ${cell.contender} ${row.phase} ${metric}`);
    if (s.summary.n < ENOUGH_RUNS) {
      throw new Error(
        `${where}: ${s.summary.n} runs of ${workload} ${cell.contender}. Publish at least ${ENOUGH_RUNS} runs per contender: ${ENOUGH_RUNS} against ${ENOUGH_RUNS} is the smallest equal pair the rank-sum test separates at the ${LEVEL * 100}% level, so a ratio of fewer could never lose its mark.`,
      );
    }
    used.add(s);
    return s;
  };

  const valueCell = (row: Row, col: ValueColumn) =>
    metricsOf(row)
      .map((metric) => {
        const s = lookup(row, col, metric);
        if (s.summary.clusters) clustered = true;
        return format(s.summary.median, metric, row.unit === undefined ? t.unit : row.unit) + (s.summary.clusters ? " †" : "");
      })
      .join(" / ");

  const ratioCell = (row: Row, col: RatioColumn) => {
    const of = valueColumn(col.ratio.of);
    const over = valueColumn(col.ratio.over);
    const parts = metricsOf(row).map((metric) => {
      if (!describe(metric).ratio) return undefined;
      const a = lookup(row, over, metric);
      const b = lookup(row, of, metric);
      const v = versus(a, b);
      if (!v.distinct) unseparated = true;
      return times(v.times) + (v.distinct ? "" : " ‡");
    });
    return parts.every((p) => p === undefined) ? "" : parts.map((p) => p ?? "–").join(" / ");
  };

  const line = (cells: readonly string[]) => `|${cells.map((c) => (c === "" ? " |" : ` ${c} |`)).join("")}`;
  const labelAt = new Map(t.columns.filter(isLabel).map((c, k) => [c, k] as const));
  const body = t.rows.map((row) => {
    const label = labelOf(row);
    if (label.length !== labelAt.size) {
      throw new Error(`the table "${t.id}", row "${label.join(" / ")}": ${label.length} labels for ${labelAt.size} label columns`);
    }
    return line(t.columns.map((col) => (isValue(col) ? valueCell(row, col) : isRatio(col) ? ratioCell(row, col) : label[labelAt.get(col)!]!)));
  });
  const table = [
    line(t.columns.map((c) => c.head)),
    `|${t.columns.map((c) => (isLabel(c) ? " --- |" : " ---: |")).join("")}`,
    ...body,
  ];
  const notes = [
    provenance(t, pub, used, size),
    ...(unseparated ? [`‡ These runs do not separate the two contenders (rank-sum test, ${LEVEL * 100}% level).`] : []),
    ...(clustered ? ["† The runs of a marked cell form two clusters, so its median hides two states."] : []),
  ];
  return [table.join("\n"), ...notes].join("\n\n");
}

const list = (items: readonly string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const distinct = <T>(items: readonly T[]) => [...new Set(items)];

/** The facts of the runs behind the table's cells, all from the records' own `host` fields. */
function provenance(t: Table, pub: Published, used: ReadonlySet<Series>, size: SizeName): string {
  const pairs = new Set([...used].map((s) => `${s.at.workload}\0${s.at.contender}`));
  const hosts = pub.runs.filter((r) => r.size === size && pairs.has(`${r.workload}\0${r.contender}`)).map((r) => r.host);

  const workloads = new Map<number, string[]>();
  for (const s of used) {
    const names = workloads.get(s.summary.n) ?? [];
    if (!names.includes(s.at.workload)) names.push(s.at.workload);
    workloads.set(s.summary.n, names);
  }
  const groups = [...workloads].sort((a, b) => b[0] - a[0]);
  const runs =
    groups.length === 1
      ? `${groups[0]![0]} runs per contender`
      : groups.map(([n, names], i) => `${n}${i === 0 ? " runs per contender" : ""} for ${list(names)}`).join(", ");

  const loads = hosts.map((h) => h.loadAvg1);
  const low = Math.min(...loads).toFixed(1);
  const high = Math.max(...loads).toFixed(1);
  const chrome = list(distinct(hosts.map((h) => /\d+/.exec(h.chrome)?.[0] ?? h.chrome)));
  const headless = hosts.every((h) => h.headless) ? "headless " : "";
  return [
    `Medians of ${runs}, in ${headless}Chrome ${chrome} on ${list(distinct(hosts.map((h) => h.cpu)))},`,
    `load average ${low === high ? low : `${low} to ${high}`}, commit ${list(distinct(hosts.map((h) => h.gitSha)))}.`,
    `Full results: [${t.file}](results/${t.file}.md).`,
  ].join(" ");
}

// ---------------------------------------------------------------- formats

/** Three significant digits, with k and M above a thousand. */
function scaled(x: number): string {
  const r = Number(x.toPrecision(3));
  const [unit, suffix] = r >= 1e6 ? [1e6, "M"] : r >= 1e3 ? [1e3, "k"] : [1, ""];
  return `${(r / unit).toPrecision(3)}${suffix}`;
}

/** Milliseconds to three significant digits, in seconds from a thousand. */
function millis(x: number, bare: boolean): string {
  const r = Number(x.toPrecision(3));
  if (bare) return r >= 1000 ? String(Math.round(r)) : r.toPrecision(3);
  return r >= 1000 ? `${(r / 1000).toPrecision(3)} s` : `${r.toPrecision(3)} ms`;
}

function format(x: number, metric: Metric, unit: string | null | undefined): string {
  const kind = metric.split(":")[0];
  const time = kind === "wall" || kind === "mean" || (kind === "main" && describe(metric).ratio);
  if (time && typeof unit === "string") throw new Error(`the unit "${unit}" is for rates, and ${metric} is a time`);
  if (kind === "rate") return unit === null ? scaled(x) : `${scaled(x)} ${unit ?? "ops/s"}`;
  if (time) return millis(x, unit === null);
  if (kind === "main") return describe(metric).format(x, false);
  throw new Error(`a docs table cannot print ${metric}`);
}

/** Two significant digits. Below 1 that takes two decimals: 0.1× would cover anything from 7 to 20 times slower. */
function times(x: number): string {
  if (!Number.isFinite(x)) return "–";
  const r = Number(x.toPrecision(2));
  return `${r >= 10 ? r.toFixed(0) : r >= 1 ? r.toFixed(1) : r >= 0.1 ? r.toFixed(2) : r}×`;
}
