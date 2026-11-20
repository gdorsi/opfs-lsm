import { defineContender } from "../../core/types.ts";
import sqlite, { openSqlite } from "./sqlite.ts";

export default defineContender({
  family: "tanstack-ondemand",
  durability: "sqlite-off",
  fastPath: `${sqlite.fastPath}; PRAGMA synchronous = OFF, so a commit is atomic but does not wait for the disk, as kv's relaxed IndexedDB commit`,
  engine: false,
  open: (name) => openSqlite(name, true),
});
