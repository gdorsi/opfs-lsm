import { captureError, errors, interactions, network, pageviews, performance, WebSDK } from "@everr/otel-web";
import type { App } from "vue";

/** Resource and record attributes that set one visitor apart from another. They never leave the browser. */
const WITHHELD = new Set(["everr.visitor.id", "everr.timezone", "browser.language", "everr.screen.width", "everr.screen.height"]);

export function startTelemetry(app: App): void {
  // Taken before `network()` wraps `fetch`, which would record each export as a span that causes the next export.
  const post = fetch;
  const base = import.meta.env.VITE_EVERR_INGEST_ENDPOINT.trim().replace(/\/+$/, "");
  const key = import.meta.env.VITE_EVERR_PUBLIC_INGEST_KEY?.trim();
  const headers = { "Content-Type": "application/json", ...(key && { Authorization: `Bearer ${key}` }) };
  new WebSDK({
    serviceName: "opfs-lsm-site",
    serviceVersion: import.meta.env.VITE_EVERR_SERVICE_VERSION,
    deploymentEnvironment: import.meta.env.MODE,
    persistence: "memory",
    send: (signal, body) =>
      post(`${base}/v1/${signal}`, {
        method: "POST",
        headers,
        body: JSON.stringify(JSON.parse(body, (_, v) => (Array.isArray(v) ? v.filter((a) => !WITHHELD.has(a?.key)) : v))),
        // Only at exit, as the SDK's own transport does. The browser refuses a keepalive body over 64 KiB.
        keepalive: document.visibilityState === "hidden",
      }),
    instrumentations: [errors(), pageviews(), interactions(), performance(), network()],
  });
  // In production Vue only logs an error a component throws, so it never reaches `errors()`.
  app.config.errorHandler = (err) => {
    console.error(err);
    captureError(err);
  };
}
