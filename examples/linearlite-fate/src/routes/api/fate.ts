import { createFileRoute } from "@tanstack/react-router";
import { defaultDbPath, openServerDb } from "../../server/db.ts";
import { createServer } from "../../server/fate.ts";

const SHARED = Symbol.for("linearlite-fate.db");

/** One database connection per process, kept on `globalThis` so a dev reload of the server code does not open it again. */
function db(): ReturnType<typeof openServerDb> {
  const g = globalThis as { [SHARED]?: ReturnType<typeof openServerDb> };
  return (g[SHARED] ??= openServerDb(defaultDbPath()));
}

let server: ReturnType<typeof createServer> | undefined;

export const Route = createFileRoute("/api/fate")({
  server: { handlers: { POST: ({ request }) => (server ??= createServer(db())).handleRequest(request) } },
});
