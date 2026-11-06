/**
 * Fail when a SharedWorker browser batch is slower than Dexie, a warm get is
 * slower than Dexie, a solitary put is over 2x Dexie, or the kv JS gzip is not
 * under Dexie's.
 *
 *   pnpm bench:gate
 *   pnpm exec tsx scripts/bench-gate.ts --fixture browser < log.txt
 *
 * The browser leg uses BENCH_N=50 and the SharedWorker.
 * Set BENCH_GATE_BROWSER_N to override that count.
 * The browser leg runs only when Chrome is on this machine.
 * BENCH_GATE_BROWSER=speed checks the ratios. BENCH_GATE_BROWSER=smoke
 * checks OPFS, the SharedWorker, and a finite post-ingest get. CI uses smoke
 * because a GitHub runner does not keep the warm-get ratio.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type BenchRow = { label: string; ms: number };

export type SpeedRule = {
  name: string;
  kv: string;
  other: string;
  maxRatio: number;
};

export type Judgment = { failures: string[]; lines: string[] };

export const BROWSER_SPEED_RULES: readonly SpeedRule[] = [
  { name: "batch", kv: "kv one batch", other: "dexie bulkPut", maxRatio: 1 },
  {
    name: "warm get",
    kv: "kv point get (warm)",
    other: "dexie point get",
    maxRatio: 1,
  },
  {
    name: "solitary put",
    kv: "kv solitary put",
    other: "dexie solitary put",
    maxRatio: 2,
  },
];

const ROW_RE = /^(.+?)\s+(\d+(?:\.\d+)?) ms\b/;

export function parseBenchRows(text: string): BenchRow[] {
  const rows: BenchRow[] = [];
  for (const line of text.split("\n")) {
    const match = ROW_RE.exec(line.trim());
    if (!match) continue;
    const label = match[1];
    const ms = Number(match[2]);
    if (!label || !Number.isFinite(ms)) continue;
    rows.push({ label, ms });
  }
  return rows;
}

function tenths(ms: number): number {
  return Math.round(ms * 10);
}

export function judgeSpeed(
  rows: readonly BenchRow[],
  rules: readonly SpeedRule[],
): Judgment {
  const msByLabel = new Map<string, number>();
  for (const row of rows) {
    if (!msByLabel.has(row.label)) msByLabel.set(row.label, row.ms);
  }

  const failures: string[] = [];
  const lines: string[] = [];
  for (const rule of rules) {
    const kv = msByLabel.get(rule.kv);
    const other = msByLabel.get(rule.other);
    const kvText = kv === undefined ? "missing" : `${kv.toFixed(1)} ms`;
    const otherText = other === undefined ? "missing" : `${other.toFixed(1)} ms`;
    lines.push(`${rule.name}: ${rule.kv} ${kvText}, ${rule.other} ${otherText}`);
    if (kv === undefined || other === undefined) {
      failures.push(`missing ${rule.name}: need "${rule.kv}" and "${rule.other}"`);
      continue;
    }
    if (tenths(kv) > rule.maxRatio * tenths(other)) {
      failures.push(
        `${rule.name}: ${rule.kv} ${kv.toFixed(1)} ms is over ${rule.maxRatio}x ${rule.other} ${other.toFixed(1)} ms`,
      );
    }
  }
  return { failures, lines };
}

export function judgeBrowserLog(text: string): Judgment {
  const speed = judgeSpeed(parseBenchRows(text), BROWSER_SPEED_RULES);
  const smoke = judgeBrowserSmoke(text);
  return {
    failures: [...speed.failures, ...smoke.failures],
    lines: [...speed.lines, ...smoke.lines],
  };
}

export function judgeBrowserSmoke(text: string): Judgment {
  const rows = parseBenchRows(text);
  const failures: string[] = [];
  const lines: string[] = [];
  if (!text.includes("OPFS=true")) failures.push("missing OPFS=true");
  if (!text.includes("mode=SharedWorker")) failures.push("missing mode=SharedWorker");
  const post = rows.find((row) => row.label === "kv point get (post-ingest)");
  if (!post || !Number.isFinite(post.ms)) {
    failures.push('missing "kv point get (post-ingest)"');
  } else {
    lines.push(`post-ingest get: ${post.ms.toFixed(1)} ms`);
  }
  return { failures, lines };
}

export function judgeBundleText(text: string): Judgment {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { failures: ["missing kv_js_gz and dexie_js_gz"], lines: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { failures: ["bundle output is not JSON"], lines: [] };
  }
  if (!parsed || typeof parsed !== "object") {
    return { failures: ["bundle output is not JSON"], lines: [] };
  }
  const record = parsed as Record<string, unknown>;
  const kvGz = record.kv_js_gz;
  const dexieGz = record.dexie_js_gz;
  if (typeof kvGz !== "number" || typeof dexieGz !== "number") {
    return { failures: ["missing kv_js_gz and dexie_js_gz"], lines: [] };
  }
  if (!Number.isFinite(kvGz) || !Number.isFinite(dexieGz)) {
    return { failures: ["missing kv_js_gz and dexie_js_gz"], lines: [] };
  }
  const wasm = record.kv_wasm_raw;
  const wasmText = typeof wasm === "number" ? `, wasm raw ${wasm}` : "";
  const lines = [`gzip: kv ${kvGz}, dexie ${dexieGz}${wasmText}`];
  if (kvGz >= dexieGz) {
    return {
      failures: [`kv gzip ${kvGz} is not under dexie gzip ${dexieGz}`],
      lines,
    };
  }
  return { failures: [], lines };
}

const kvRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function finish(label: string, judgment: Judgment): number {
  for (const line of judgment.lines) console.log(`${label} ${line}`);
  if (judgment.failures.length === 0) {
    console.log(`${label}: pass`);
    return 0;
  }
  console.error(`${label}: fail`);
  for (const failure of judgment.failures) console.error(`  ${failure}`);
  return 1;
}

function runFixture(kind: string | undefined): number {
  const text = readFileSync(0, "utf8");
  if (kind === "browser") return finish("browser", judgeBrowserLog(text));
  if (kind === "bundle") return finish("bundle", judgeBundleText(text));
  console.error("fixture kind must be browser or bundle");
  return 1;
}

function findChrome(): { bin?: string; error?: string } {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv) {
    if (existsSync(fromEnv)) return { bin: fromEnv };
    return { error: `CHROME_PATH does not exist: ${fromEnv}` };
  }
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(mac)) return { bin: mac };
  for (const name of [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ]) {
    const found = spawnSync("which", [name], { encoding: "utf8" });
    const line = found.stdout?.trim();
    if (found.status === 0 && line) return { bin: line };
  }
  return {};
}

function runTsx(
  script: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): { status: number; output: string } {
  const result = spawnSync("pnpm", ["exec", "tsx", script], {
    cwd: kvRoot,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) {
    return { status: 1, output: `${output}\n${result.error.message}` };
  }
  return { status: result.status ?? 1, output };
}

function gateLive(): number {
  const build = spawnSync("pnpm", ["run", "build"], {
    cwd: kvRoot,
    stdio: "inherit",
    env: process.env,
  });
  if ((build.status ?? 1) !== 0) return build.status ?? 1;

  let failed = false;

  const bundle = runTsx("scripts/measure-bundle.ts", process.env, 60_000);
  process.stdout.write(bundle.output);
  const bundleJudgment = judgeBundleText(bundle.output);
  if (bundle.status !== 0) {
    bundleJudgment.failures.push(`bundle measure exited ${bundle.status}`);
  }
  if (finish("bundle", bundleJudgment) !== 0) failed = true;

  const chrome = findChrome();
  if (chrome.error) {
    console.error(chrome.error);
    return 1;
  }
  if (!chrome.bin) {
    console.log("browser: skipped because chrome was not found");
    console.log(failed ? "gate: fail" : "gate: pass");
    return failed ? 1 : 0;
  }

  const browserMode = process.env.BENCH_GATE_BROWSER ?? "speed";
  if (browserMode !== "speed" && browserMode !== "smoke") {
    console.error("BENCH_GATE_BROWSER must be speed or smoke");
    return 1;
  }
  const browserEnv = {
    ...process.env,
    BENCH_N: process.env.BENCH_GATE_BROWSER_N ?? "50",
  };
  delete browserEnv.BENCH_LOCAL;
  delete browserEnv.BENCH_SW;
  const browser = runTsx("scripts/bench-browser.ts", browserEnv, 300_000);
  process.stdout.write(browser.output);
  const browserJudgment =
    browserMode === "smoke"
      ? judgeBrowserSmoke(browser.output)
      : judgeBrowserLog(browser.output);
  if (browser.status !== 0) {
    browserJudgment.failures.push(`browser bench exited ${browser.status}`);
  }
  if (finish("browser", browserJudgment) !== 0) failed = true;
  console.log(failed ? "gate: fail" : "gate: pass");
  return failed ? 1 : 0;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isDirectRun()) {
  const fixtureAt = process.argv.indexOf("--fixture");
  const code =
    fixtureAt === -1 ? gateLive() : runFixture(process.argv[fixtureAt + 1]);
  process.exit(code);
}
