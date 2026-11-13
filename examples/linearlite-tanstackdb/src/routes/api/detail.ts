import { createFileRoute } from "@tanstack/react-router";
import { parseDetailRequest } from "../../domain/wire.ts";
import { respond } from "../../server/http.ts";
import { appServer } from "../../server/sqlite.ts";

export const Route = createFileRoute("/api/detail")({
  server: {
    handlers: {
      GET: ({ request }) =>
        respond(() => appServer().detail(parseDetailRequest(new URL(request.url).searchParams).ids)),
    },
  },
});
