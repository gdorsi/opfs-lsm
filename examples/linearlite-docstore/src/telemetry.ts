import {
  captureError,
  errors,
  interactions,
  network,
  pageviews,
  performance as webVitals,
  setAttributes,
  WebSDK,
  type InstrumentationContext,
} from "@everr/otel-web";
import type { ReadPath } from "./store.ts";

export type Kpi = {
  readonly name: `linearlite.${string}`;
  readonly ms: number;
  readonly attributes: { readonly [key: `linearlite.${string}`]: number | boolean | ReadPath | undefined };
};

const endpoint = import.meta.env?.VITE_EVERR_INGEST_ENDPOINT;
const on = !!endpoint && (navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl !== true && navigator.doNotTrack !== "1";
/** Set by the last instrumentation below. The SDK sends an event with a name only through an instrumentation. */
let emit: InstrumentationContext["emit"] | undefined;

if (on) {
  /** Resource and record attributes that set one visitor apart from another. They never leave the browser. */
  const withheld = new Set(["everr.visitor.id", "everr.timezone", "browser.language", "everr.screen.width", "everr.screen.height"]);
  // Taken before `network()` wraps `fetch`, which would record each export as a span that causes the next export.
  const post = fetch;
  const base = endpoint.trim().replace(/\/+$/, "");
  const key = import.meta.env.VITE_EVERR_PUBLIC_INGEST_KEY?.trim();
  const headers = { "Content-Type": "application/json", ...(key && { Authorization: `Bearer ${key}` }) };
  // Before the client: it records the first page view as it is constructed.
  setAttributes({
    "linearlite.framed": parent !== window,
    "linearlite.navigation": (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type ?? null,
    "linearlite.device.cores": navigator.hardwareConcurrency,
    "linearlite.device.memory_gb": (navigator as { deviceMemory?: number }).deviceMemory ?? null,
  });
  new WebSDK({
    serviceName: "opfs-lsm-demo",
    serviceVersion: import.meta.env.VITE_EVERR_SERVICE_VERSION,
    deploymentEnvironment: import.meta.env.MODE,
    persistence: "memory",
    send: (signal, body) =>
      post(`${base}/v1/${signal}`, {
        method: "POST",
        headers,
        body: JSON.stringify(JSON.parse(body, (_, v) => (Array.isArray(v) ? v.filter((a) => !withheld.has(a?.key)) : v))),
        // Only at exit, as the SDK's own transport does. The browser refuses a keepalive body over 64 KiB.
        keepalive: document.visibilityState === "hidden",
      }),
    // Redact's `nano` preset has no error boundaries. It sends a render error to `reportError`, which `errors()`
    // records.
    instrumentations: [errors(), pageviews(), interactions(), webVitals(), network(), (ctx) => void (emit = ctx.emit)],
  });
}

export const record = ({ name, ms, attributes }: Kpi) => emit?.(name, { "linearlite.duration_ms": ms, ...attributes });

export const report = (err: unknown) => {
  if (on) captureError(err);
};
