import { createFileRoute } from "@tanstack/react-router";
import { parsePullRequest } from "../../domain/wire.ts";
import { respond } from "../../server/http.ts";
import { appServer } from "../../server/sqlite.ts";

export const Route = createFileRoute("/api/pull")({
  server: {
    handlers: {
      GET: ({ request }) =>
        respond(() => {
          const { stream, after, limit } = parsePullRequest(new URL(request.url).searchParams);
          return appServer().pull(stream, after, limit);
        }),
    },
  },
});
