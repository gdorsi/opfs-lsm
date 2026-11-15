import { createFileRoute } from "@tanstack/react-router";
import { parsePushRequest, parseUsername } from "../../domain/wire.ts";
import { respond } from "../../server/http.ts";
import { appServer } from "../../server/sqlite.ts";

export const Route = createFileRoute("/api/push")({
  server: {
    handlers: {
      POST: ({ request }) =>
        respond(async () => {
          const username = parseUsername(request.headers.get("x-linearlite-user"));
          const { ops } = parsePushRequest(await request.json().catch(() => null));
          return appServer().push(ops, username);
        }),
    },
  },
});
