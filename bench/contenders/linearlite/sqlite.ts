import { openBrowserWASQLiteOPFSDatabase } from "@tanstack/browser-db-sqlite-persistence";
import { openSqliteBackend, SQLITE_PATH } from "../../../examples/linearlite-tanstackdb/src/backends/sqlite.ts";
import { defineContender } from "../../core/types.ts";
import { describePath } from "../../page/linearlite.ts";

export default defineContender({
  family: "linearlite",
  durability: "sqlite-full",
  fastPath: describePath(SQLITE_PATH),
  engine: false,
  async open(name) {
    const database = await openBrowserWASQLiteOPFSDatabase({ databaseName: `linearlite-${name}.sqlite` });
    const backend = await openSqliteBackend(database, { name: `linearlite-${name}`, hidden: () => document.hidden });
    return {
      backend,
      settle: async () => {},
      stats: async () => undefined,
      close: async () => {
        await backend.close();
        await database.close?.();
      },
    };
  },
});
