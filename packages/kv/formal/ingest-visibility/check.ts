/**
 * Exhaustive check: a page reads its acked writes across every
 * interleaving of more appends, the SharedWorker's ingest round and the
 * page's install of the manifest it publishes, in the step order the
 * source uses (parsed from `ingestQueues` and `DbImpl.install`).
 *
 * Run: pnpm --filter @opfs-lsm/kv formal:ingest-visibility
 *
 * Broken orders must each fail, so the model can see the bug: a manifest
 * published before its run, and an install that drops the page's own
 * records before it swaps in the runs that hold them, with a task between.
 */
import path from "node:path";
import { explore, type Order } from "./model.js";
import { loadOrder } from "./parse.js";

const MAX_APPENDS = 3;

const source = loadOrder();
console.log(`round order from ${path.relative(process.cwd(), source.files[0]!)}: ${source.round.join(" -> ")}`);
console.log(`install from ${path.relative(process.cwd(), source.files[1]!)}: ${source.install.join(" + ")}${source.installAtomic ? " in one task" : " with an await between"}`);
console.log(`bound: ${MAX_APPENDS} appends, one key, one round and one install in flight`);
console.log("property: NoLostAcks, the page reads its newest acked write");

const { states, violation } = explore(source, MAX_APPENDS);
if (violation) {
  console.error(`\nFAIL NoLostAcks after ${states} states; shortest path:`);
  violation.forEach((l, i) => console.error(`  ${i + 1}. ${l}`));
  console.error("\nHarm: a page acked a write, then a get on that page missed it while the host ingested it.");
  process.exit(1);
}

const broken: [string, Order][] = [
  ["manifest before its run", { ...source, round: ["publishGeneration", "publishL0"] }],
  ["drop own records, then swap runs, a task apart", { ...source, install: ["dropOwn", "swapRuns"], installAtomic: false }],
];
for (const [name, order] of broken) {
  if (!explore(order, MAX_APPENDS).violation) {
    console.error(`FAIL the model misses a broken order: ${name}`);
    process.exit(1);
  }
}
console.log(`\nPASS NoLostAcks: ${states} states, and ${broken.length} broken orders each fail`);
