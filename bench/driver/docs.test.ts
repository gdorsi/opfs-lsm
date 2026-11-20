import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe as suite, test } from "node:test";
import type { MainThread, PhaseResult, RunRecord } from "../core/types.ts";
import { LEGACY_DIRTY, readPublished, renderDocs, staleTables, type Published, type Table } from "./docs.ts";
import { measure } from "./metrics.ts";

const HOST = { chrome: "Chrome/157.0.8103.79", headless: true, os: "", cpu: "Test CPU", cores: 1, loadAvg1: 2, node: "", gitSha: "abc1234" };

const phase = (name: string, over: Partial<PhaseResult> = {}): PhaseResult => ({
  name,
  page: "same",
  timed: true,
  wallMs: 1000,
  spanMs: 1000,
  ops: 1000,
  userBytes: 0,
  latency: {},
  ...over,
});

/** A run of `kops` thousand reads per second. */
function run(contender: string, kops: number, over: Partial<RunRecord> = {}): RunRecord {
  return {
    workload: "kv/test",
    contender,
    durability: "none",
    fastPath: "",
    size: "small",
    rep: 0,
    params: { entries: 1, keyBytes: 1, valueBytes: 1, compressibility: 0, batch: 1, ops: 1, seed: 1 },
    host: HOST,
    phases: [phase("read", { ops: kops * 1000, wallMs: 1000, spanMs: 1000 })],
    ...over,
  };
}

const runsOf = (contender: string, kops: number[], over: Partial<RunRecord> = {}) => kops.map((k) => run(contender, k, over));
const published = (records: readonly RunRecord[]): Published => ({ measures: measure(records), runs: records });

const TABLE: Table = {
  id: "reads",
  file: "2026-01-01T00-00-00-test",
  workload: "kv/test",
  columns: [{ head: "Workload" }, { head: "IndexedDB", at: "kv/idb" }, { head: "kv", at: "kv/kv" }, { head: "", ratio: { of: "kv", over: "IndexedDB" } }],
  rows: [{ label: "Random reads", phase: "read", metric: "rate" }],
};

const OPEN = "<!-- bench:table reads -->";
const CLOSE = "<!-- /bench:table -->";
const PAGE = `# Title\n\nText before.\n\n${OPEN}\n| stale | table |\n${CLOSE}\n\nText after, with | pipes | and <!-- a comment -->.\n`;

const render = (idb: number[], kv: number[], table: Table = TABLE, page = PAGE) =>
  renderDocs(page, [table], () => published([...runsOf("kv/idb", idb), ...runsOf("kv/kv", kv)]));

suite("renderDocs", () => {
  test("writes the table between its markers and leaves the other text byte for byte", () => {
    const out = render([95, 100, 100, 105], [190, 200, 200, 210]);
    const [before, rest] = out.split(OPEN) as [string, string];
    const [block, after] = rest.split(CLOSE) as [string, string];
    assert.equal(before, "# Title\n\nText before.\n\n");
    assert.equal(after, "\n\nText after, with | pipes | and <!-- a comment -->.\n");
    assert.match(block, /^\n\| Workload \| IndexedDB \| kv \| \|\n\| --- \| ---: \| ---: \| ---: \|\n\| Random reads \| 100k ops\/s \| 200k ops\/s \| 2\.0× \|\n/);
  });

  test("rendering twice changes nothing", () => {
    const once = render([95, 100, 100, 105], [190, 200, 200, 210]);
    assert.equal(render([95, 100, 100, 105], [190, 200, 200, 210], TABLE, once), once);
  });

  test("a provenance line states the runs, Chrome, CPU, load, commit and the link", () => {
    const records = [...runsOf("kv/idb", [100, 100, 100, 100], { host: { ...HOST, loadAvg1: 1.94 } }), ...runsOf("kv/kv", [200, 200, 200, 200], { host: { ...HOST, loadAvg1: 4.52 } })];
    const out = renderDocs(PAGE, [TABLE], () => published(records));
    assert.match(
      out,
      /Medians of 4 runs per contender, in headless Chrome 157 on Test CPU, load average 1\.9 to 4\.5, commit abc1234\. Full results: \[2026-01-01T00-00-00-test\]\(results\/2026-01-01T00-00-00-test\.md\)\./,
    );
  });

  test("two run counts name the workloads that have each", () => {
    const records = [...runsOf("kv/idb", [100, 100, 100, 100, 100]), ...runsOf("kv/kv", [200, 200, 200, 200, 200]), ...runsOf("kv/idb", [5, 5, 5, 5], { workload: "kv/other" }), ...runsOf("kv/kv", [9, 9, 9, 9], { workload: "kv/other" })];
    const two: Table = { ...TABLE, rows: [...TABLE.rows, { label: "Other reads", workload: "kv/other", phase: "read", metric: "rate" }] };
    const out = renderDocs(PAGE, [two], () => published(records));
    assert.match(out, /Medians of 5 runs per contender for kv\/test, 4 for kv\/other, in headless/);
  });

  test("a ratio of runs the test does not separate is printed with a ‡ and the page says what it means", () => {
    const out = render([95, 100, 100, 150], [100, 120, 120, 170]);
    assert.match(out, /\| Random reads \| 100k ops\/s \| 120k ops\/s \| 1\.2× ‡ \|/);
    assert.match(out, /\n‡ These runs do not separate the two contenders \(rank-sum test, 5% level\)\.\n/);
    assert.doesNotMatch(render([95, 100, 100, 105], [190, 200, 200, 210]), /‡/);
  });

  test("runs whose ranges overlap but whose ranks separate carry no ‡", () => {
    assert.doesNotMatch(render([42.8, 42.5, 43, 42.8, 47.4], [47.9, 47.6, 48.1, 47.3, 47.8]), /‡/);
  });

  test("a ratio of fewer than 4 runs per side throws and names the table, the row and the run counts", () => {
    assert.throws(
      () => render([95, 100, 105], [190, 200, 210]),
      /table "reads", row "Random reads", column "": 3 runs against 3 cannot show a difference.*at least 4 runs per contender/,
    );
    assert.throws(() => render([95, 100, 105, 98], [190]), /4 runs against 1 cannot show a difference/);
  });

  test("a cell whose runs form two clusters is marked with a †, and a legend follows", () => {
    const low = [426, 440, 452, 460, 468, 471, 475, 480, 484, 488];
    const high = [592, 600, 610, 618, 625, 631, 640, 648, 655, 658, 662];
    const out = render([20, 21, 22, 23, 24], [...low, ...high]);
    assert.match(out, /\| 22\.0k ops\/s \| 592k ops\/s † \|/);
    assert.match(out, /\n† The runs of a marked cell form two clusters, so its median hides two states\.\n/);
    assert.doesNotMatch(render([20, 21, 22, 23, 24], [100, 101, 102, 103, 104]), /†/);
  });

  test("a cell with no series throws and names the table, the row and the column", () => {
    const records = [...runsOf("kv/idb", [100, 100, 100])];
    assert.throws(
      () => renderDocs(PAGE, [TABLE], () => published(records)),
      /table "reads", row "Random reads", column "kv": 2026-01-01T00-00-00-test has no series kv\/test kv\/kv read rate/,
    );
  });

  test("a marker with no table throws", () => {
    assert.throws(() => renderDocs(PAGE, [], () => published([])), /marker "reads" has no table/);
  });

  test("a table with no marker throws", () => {
    assert.throws(() => renderDocs("# Title\n", [TABLE], () => published([])), /table "reads" has no marker/);
  });

  test("a marker that is never closed throws", () => {
    assert.throws(() => render([100], [200], TABLE, `${OPEN}\n| a |\n`), /do not pair up/);
  });

  test("a file with no run of the table's size throws", () => {
    const tiny = { ...TABLE, size: "tiny" } as const;
    assert.throws(() => render([100, 100], [200, 200], tiny), /has no record of size "tiny"/);
  });

  test("a pair of metrics prints as one cell and one ratio, and a count has no ratio", () => {
    const main: MainThread = { longTasks: 0, longestMs: 0, blockedMs: 0, frames: 10, frameIntervalMs: 16, longestFrameMs: 16, droppedFrames: 0 };
    const cold = { n: 1, sumUs: 2000, minUs: 0, maxUs: 2000, buckets: [] };
    const records = (contender: string, wall: number, dropped: number) =>
      [1, 2, 3, 4].map((i) =>
        run(contender, 1, { phases: [phase("read", { wallMs: wall + i, latency: { cold }, mainThread: { ...main, droppedFrames: dropped } })] }),
      );
    const both: Table = {
      ...TABLE,
      unit: null,
      rows: [
        { label: "A pair", phase: "read", metric: ["mean:cold", "wall"] },
        { label: "Dropped frames", phase: "read", metric: "main:droppedFrames" },
      ],
    };
    const out = renderDocs(PAGE, [both], () => published([...records("kv/idb", 600, 4), ...records("kv/kv", 300, 3)]));
    assert.match(out, /\| A pair \| 2\.00 \/ 603 \| 2\.00 \/ 303 \| 1\.0× ‡ \/ 2\.0× \|\n/);
    assert.match(out, /\| Dropped frames \| 4 \| 3 \| \|\n/);
  });
});

suite("value formats", () => {
  const cell = (kops: number, over: Partial<Table["rows"][number]> = {}, table: Partial<Table> = {}) => {
    const t: Table = { ...TABLE, ...table, rows: [{ label: "Row", phase: "read", metric: "rate", ...over }] };
    const out = renderDocs(PAGE, [t], () => published([...runsOf("kv/idb", [kops, kops, kops, kops]), ...runsOf("kv/kv", [kops, kops, kops, kops])]));
    return /\| Row \| ([^|]+) \|/.exec(out)![1]!;
  };

  test("a rate has three significant digits, k and M above a thousand, and its own unit", () => {
    assert.equal(cell(41.99), "42.0k ops/s");
    assert.equal(cell(1894), "1.89M ops/s");
    assert.equal(cell(0.875), "875 ops/s");
    assert.equal(cell(0.9996), "1.00k ops/s");
    assert.equal(cell(131, { unit: "rows/s" }), "131k rows/s");
    assert.equal(cell(131, {}, { unit: null }), "131k");
  });

  test("a time is in ms with three significant digits, and in s from a thousand ms", () => {
    const time = (ms: number, over: Partial<Table["rows"][number]> = {}, table: Partial<Table> = {}) => {
      const t: Table = { ...TABLE, ...table, rows: [{ label: "Row", phase: "read", metric: "wall", ...over }] };
      const records = ["kv/idb", "kv/kv"].flatMap((c) => runsOf(c, [1, 1, 1, 1]).map((r) => ({ ...r, phases: [phase("read", { wallMs: ms })] })));
      return /\| Row \| ([^|]+) \|/.exec(renderDocs(PAGE, [t], () => published(records)))![1]!;
    };
    assert.equal(time(0.118), "0.118 ms");
    assert.equal(time(6.74), "6.74 ms");
    assert.equal(time(12), "12.0 ms");
    assert.equal(time(2400), "2.40 s");
    assert.equal(time(999.7), "1.00 s");
    assert.equal(time(5.4, {}, { unit: null }), "5.40");
    assert.throws(() => time(5.4, { unit: "rows/s" }), /is for rates/);
  });

  test("a ratio is an integer from ten, and one decimal below", () => {
    const ratio = (idb: number, kv: number) => {
      const out = render([idb, idb, idb, idb], [kv, kv, kv, kv]);
      return /\| ([^|]+) \|\n/.exec(out.split("\n").find((l) => l.startsWith("| Random reads"))! + "\n")![1]!;
    };
    assert.equal(ratio(10, 123), "12×");
    assert.equal(ratio(100, 200), "2.0×");
    assert.equal(ratio(100, 93), "0.93×");
    assert.equal(ratio(100, 12), "0.12×");
    assert.equal(ratio(1, 78), "78×");
  });
});

suite("readPublished", () => {
  const stamp = "2026-02-02T00-00-00-test";
  const dir = mkdtempSync(path.join(tmpdir(), "docs-test-"));
  const write = (name: string, records: RunRecord[]) => writeFileSync(path.join(dir, `${name}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const dirty = [...runsOf("kv/idb", [100, 100]), ...runsOf("kv/kv", [200, 200])].map((r) => ({ ...r, host: { ...r.host, gitSha: "abc1234-dirty" } }));

  test("a run recorded on a tree with uncommitted changes is refused", () => {
    write(stamp, dirty);
    assert.throws(() => readPublished(stamp, dir), /abc1234-dirty, a tree with uncommitted changes/);
  });

  test("a run from a clean tree loads its series and its hosts", () => {
    write(stamp, runsOf("kv/kv", [100, 200]));
    const pub = readPublished(stamp, dir);
    assert.equal(pub.measures.all.length > 0, true);
    assert.deepEqual(pub.runs.map((r) => r.host.gitSha), ["abc1234", "abc1234"]);
  });

  test("a run that overrode a kv option is refused", () => {
    const stamp = "2026-01-03T00-00-00-small-cache";
    write(stamp, runsOf("kv/kv", [200, 200], { kv: { cacheBytes: 4_194_304 } }));
    assert.throws(() => readPublished(stamp, dir), /opened kv with cacheBytes 4194304/);
  });

  test("a run on a seed other than the default is refused", () => {
    const stamp = "2026-01-04T00-00-00-seed";
    write(stamp, runsOf("kv/kv", [200, 200], { params: { ...run("kv/kv", 1).params, seed: 7 } }));
    assert.throws(() => readPublished(stamp, dir), /used seed 7\. Publish a run on the default seed 1/);
  });

  test("the legacy list holds only the three runs published before the rule, so it can only shrink", () => {
    const before = ["2026-11-17T20-16-52-apple-m5-max", "2026-11-17T20-27-42-apple-m5-max", "2026-11-17T20-29-34-apple-m5-max"];
    assert.deepEqual([...LEGACY_DIRTY].filter((stamp) => !before.includes(stamp)), []);
  });

  test("a legacy stamp loads, and its table prints the commit with -dirty", () => {
    for (const legacy of LEGACY_DIRTY) {
      write(legacy, dirty);
      assert.match(renderDocs(PAGE, [{ ...TABLE, file: legacy }], () => readPublished(legacy, dir)).split("\n").find((l) => l.startsWith("Medians"))!, /commit abc1234-dirty\./);
    }
  });

  test("a failed run is neither a series nor a published run", () => {
    write(stamp, [...runsOf("kv/kv", [100, 200]), { ...run("kv/kv", 999), error: "timeout" }]);
    const pub = readPublished(stamp, dir);
    assert.equal(pub.runs.length, 2);
    assert.equal(pub.measures.all.find((s) => s.at.metric === "rate")!.summary.max, 200_000);
  });

  test.after(() => rmSync(dir, { recursive: true, force: true }));
});

suite("staleTables", () => {
  const read = () => published([...runsOf("kv/idb", [95, 100, 100, 105]), ...runsOf("kv/kv", [190, 200, 200, 210])]);

  test("names the tables whose text differs from the runs, and none once the page is rendered", () => {
    assert.deepEqual(staleTables(PAGE, [TABLE], read), ["reads"]);
    const current = renderDocs(PAGE, [TABLE], read);
    assert.deepEqual(staleTables(current, [TABLE], read), []);
    assert.deepEqual(staleTables(current.replace("200k ops/s", "201k ops/s"), [TABLE], read), ["reads"]);
  });
});
