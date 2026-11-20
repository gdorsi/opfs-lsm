import { defineContender } from "../../core/types.ts";
import sqlite, { openSqlite } from "./sqlite.ts";

export default defineContender({
  family: "tanstack-live",
  durability: "sqlite-off",
  fastPath: `${sqlite.fastPath}; PRAGMA synchronous = OFF, so a commit does not wait for the disk, as kv's relaxed IndexedDB commit; unlike it, a power loss can corrupt the database`,
  engine: false,
  open: (name) => openSqlite(name, true),
});
