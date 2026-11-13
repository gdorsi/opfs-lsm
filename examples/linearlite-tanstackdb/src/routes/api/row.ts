import { createFileRoute } from "@tanstack/react-router";
import { parseRowRequest } from "../../domain/wire.ts";
import { respond } from "../../server/http.ts";
import { appServer } from "../../server/sqlite.ts";

export const Route = createFileRoute("/api/row")({
  server: {
    handlers: {
      GET: ({ request }) =>
        respond(() => {
          const { stream, id } = parseRowRequest(new URL(request.url).searchParams);
          return appServer().row(stream, id);
        }),
    },
  },
});
