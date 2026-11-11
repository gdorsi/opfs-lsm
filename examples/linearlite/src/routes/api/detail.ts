import { createFileRoute } from "@tanstack/react-router";
import { parseDetailRequest } from "../../domain/wire.ts";
import { serverDb } from "../../server/db.ts";
import { respond } from "../../server/http.ts";
import { detail } from "../../server/sync.ts";

export const Route = createFileRoute("/api/detail")({
  server: {
    handlers: {
      GET: ({ request }) =>
        respond(() => detail(serverDb(), parseDetailRequest(new URL(request.url).searchParams).id)),
    },
  },
});
