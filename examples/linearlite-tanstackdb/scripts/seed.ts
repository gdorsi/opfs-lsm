import { parseArgs } from "node:util";
import { defaultDbPath, openServerDb, seedDb } from "../src/server/sqlite.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { db: { type: "string" } } });
const count = Number(positionals[0]);
if (!Number.isInteger(count) || count < 1) {
  console.error("usage: node scripts/seed.ts <count> [--db path]");
  process.exit(2);
}

const path = values.db ?? defaultDbPath();
const db = openServerDb(path);
const t0 = performance.now();
const { rows, head } = seedDb(db, count);
const seconds = (performance.now() - t0) / 1000;
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();
console.log(`seeded ${count} issues (${rows} rows, head ${head}) into ${path} in ${seconds.toFixed(2)}s, ${Math.round(rows / seconds)} rows/s`);
