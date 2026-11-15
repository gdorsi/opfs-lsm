import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/fate")({
  server: { handlers: { POST: () => Response.json({ error: "no tree server yet" }, { status: 503 }) } },
});
