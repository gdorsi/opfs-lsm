import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  judgeBrowserLog,
  judgeBrowserSmoke,
  judgeBundleText,
  parseBenchRows,
} from "../scripts/bench-gate.js";

const kvRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const browserPass = `
OPFS=true  SharedWorker=true
mode=SharedWorker + BrowserFs (OPFS)
kv solitary put               9.6 ms  (5208 ops/s)
kv one batch                  0.4 ms  (125000 ops/s)
kv point get (warm)           1.4 ms  (35714 ops/s)
kv point get (post-ingest)    2.1 ms  (23810 ops/s)
dexie solitary put            9.2 ms  (5435 ops/s)
dexie bulkPut                 1.2 ms  (41667 ops/s)
dexie point get               3.1 ms  (16129 ops/s)
`;

const browserBatchLost = `
OPFS=true  SharedWorker=true
mode=SharedWorker + BrowserFs (OPFS)
kv solitary put               9.6 ms
kv one batch                  9.0 ms
kv point get (warm)           1.4 ms
kv point get (post-ingest)    2.1 ms
dexie solitary put            9.2 ms
dexie bulkPut                 1.0 ms
dexie point get               3.1 ms
`;

describe("bench gate", () => {
  it("reads the printed millisecond rows", () => {
    const rows = parseBenchRows(browserPass);
    expect(rows.find((row) => row.label === "kv one batch")?.ms).toBe(0.4);
    expect(rows.find((row) => row.label === "dexie point get")?.ms).toBe(3.1);
  });

  it("passes the SharedWorker log from the written prototype shape", () => {
    expect(judgeBrowserLog(browserPass).failures).toEqual([]);
  });

  it("fails when the batch is slower than Dexie", () => {
    expect(judgeBrowserLog(browserBatchLost).failures.join("\n")).toContain("batch");
  });

  it("fails when a solitary put is over 2x Dexie", () => {
    const text = browserPass.replace(
      "kv solitary put               9.6 ms",
      "kv solitary put              20.0 ms",
    );
    expect(judgeBrowserLog(text).failures.join("\n")).toContain("solitary put");
  });

  it("passes when a solitary put is exactly 2x Dexie", () => {
    const text = browserPass
      .replace("kv solitary put               9.6 ms", "kv solitary put              18.4 ms")
      .replace("dexie solitary put            9.2 ms", "dexie solitary put            9.2 ms");
    expect(judgeBrowserLog(text).failures).toEqual([]);
  });

  it("fails when a browser row the rule needs is absent", () => {
    expect(judgeBrowserLog("OPFS=true\nmode=SharedWorker\nkv one batch  0.4 ms\n").failures.join("\n")).toContain(
      "missing",
    );
  });

  it("fails when a browser warm get is slower than Dexie", () => {
    const text = browserPass.replace(
      "kv point get (warm)           1.4 ms",
      "kv point get (warm)           9.0 ms",
    );
    expect(judgeBrowserLog(text).failures.join("\n")).toContain("warm get");
    expect(judgeBrowserSmoke(text).failures).toEqual([]);
  });

  it("fails a browser log that never read an SST", () => {
    const text = browserPass.replace("kv point get (post-ingest)    2.1 ms  (23810 ops/s)\n", "");
    expect(judgeBrowserLog(text).failures.join("\n")).toContain("post-ingest");
  });

  it("fails a browser log that stayed on the in-page engine", () => {
    const text = browserPass.replace("mode=SharedWorker", "mode=local");
    expect(judgeBrowserLog(text).failures.join("\n")).toContain("mode=SharedWorker");
  });

  it("fails when kv gzip is not under Dexie", () => {
    const under = JSON.stringify({ kv_js_gz: 11461, dexie_js_gz: 32822 });
    const tied = JSON.stringify({ kv_js_gz: 32822, dexie_js_gz: 32822 });
    expect(judgeBundleText(under).failures).toEqual([]);
    expect(judgeBundleText(tied).failures.join("\n")).toContain("not under");
  });

  it("exits non-zero on an inverted batch fixture", () => {
    const result = spawnSync(
      "pnpm",
      ["exec", "tsx", "scripts/bench-gate.ts", "--fixture", "browser"],
      { cwd: kvRoot, input: browserBatchLost, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("batch");
  });
});
