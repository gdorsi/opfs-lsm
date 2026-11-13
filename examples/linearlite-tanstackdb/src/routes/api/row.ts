import { createFileRoute } from "@tanstack/react-router";
import { parseRowRequest } from "../../domain/wire.ts";
import { serverDb } from "../../server/db.ts";
import { respond } from "../../server/http.ts";
import { row } from "../../server/sync.ts";

export const Route = createFileRoute("/api/row")({
  server: {
    handlers: {
      GET: ({ request }) =>
        respond(() => {
          const { stream, id } = parseRowRequest(new URL(request.url).searchParams);
          return row(serverDb(), stream, id);
        }),
    },
  },
});
