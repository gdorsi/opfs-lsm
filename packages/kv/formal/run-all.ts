/**
 * Run every kv formal check. Exit non-zero on first failure.
 *
 *   pnpm --filter @opfs-lsm/kv formal:kv
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const kvRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const checks = [
  "formal/ingest-visibility/check.ts",
  "formal/own-over-runs/check.ts",
  "formal/view-pin/check.ts",
  "formal/compact-preserve/check.ts",
  "formal/ingest-plan/check.ts",
] as const;

let failed = 0;
for (const rel of checks) {
  console.log(`\n=== ${rel} ===`);
  const r = spawnSync("pnpm", ["exec", "tsx", rel], {
    stdio: "inherit",
    cwd: kvRoot,
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    failed++;
    console.error(`FAILED ${rel} (exit ${r.status ?? "?"})`);
  }
}

if (failed) {
  console.error(`\n${failed}/${checks.length} formal checks failed`);
  process.exit(1);
}
console.log(`\nAll ${checks.length} formal checks passed`);
