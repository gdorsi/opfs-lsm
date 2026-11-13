import { createFileRoute } from "@tanstack/react-router";
import { appServer } from "../../server/sqlite.ts";

const PING_MS = 25_000;

export const Route = createFileRoute("/api/events")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const encoder = new TextEncoder();
        let stop = () => {};
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
            const head = (n: number) => send(`data: {"head":${n}}\n\n`);
            const off = appServer().onHead(head);
            const ping = setInterval(() => send(": ping\n\n"), PING_MS);
            stop = () => {
              off();
              clearInterval(ping);
              try {
                controller.close();
              } catch {}
            };
            request.signal.addEventListener("abort", stop, { once: true });
            head(appServer().head());
          },
          cancel: () => stop(),
        });
        return new Response(body, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
        });
      },
    },
  },
});
