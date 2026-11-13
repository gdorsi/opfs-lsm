import { parseArgs } from "node:util";
import { defaultDbPath, openServerDb } from "../src/server/db.ts";
import { seedDb } from "../src/server/seed.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { db: { type: "string" } } });
const count = Number(positionals[0]);
if (!Number.isInteger(count) || count < 1) {
  console.error("usage: node scripts/seed.ts <count> [--db path]");
  process.exit(2);
}

const path = values.db ?? defaultDbPath();
const db = openServerDb(path);
const t0 = performance.now();
const { issues, comments } = seedDb(db, count);
const seconds = (performance.now() - t0) / 1000;
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();
console.log(`seeded ${issues} issues and ${comments} comments into ${path} in ${seconds.toFixed(2)}s`);
