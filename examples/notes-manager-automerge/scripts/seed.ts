import { parseArgs } from "node:util";
import { defaultDbPath, openServerDb } from "../src/server/db.ts";
import { seedDb } from "../src/server/seed.ts";

const { values } = parseArgs({ options: { db: { type: "string" } } });
const path = values.db ?? defaultDbPath();
const db = openServerDb(path);
const { pages } = seedDb(db);
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();
console.log(`seeded ${pages} pages into ${path}`);
