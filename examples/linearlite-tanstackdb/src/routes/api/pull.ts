import { createFileRoute } from "@tanstack/react-router";
import { parsePullRequest } from "../../domain/wire.ts";
import { serverDb } from "../../server/db.ts";
import { pull } from "../../server/sync.ts";
import { respond } from "../../server/http.ts";

export const Route = createFileRoute("/api/pull")({
  server: {
    handlers: {
      GET: ({ request }) =>
        respond(() => {
          const { stream, after, limit } = parsePullRequest(new URL(request.url).searchParams);
          return pull(serverDb(), stream, after, limit);
        }),
    },
  },
});
