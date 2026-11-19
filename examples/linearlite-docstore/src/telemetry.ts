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
/** Set by the last instrumentation below. The SDK sends an event with a name only through an instrumentation. */
let emit: InstrumentationContext["emit"] | undefined;

if (endpoint) {
  // Before the client: it records the first page view as it is constructed.
  setAttributes({
    "linearlite.framed": parent !== window,
    "linearlite.navigation": (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type ?? null,
    "linearlite.device.cores": navigator.hardwareConcurrency,
    "linearlite.device.memory_gb": (navigator as { deviceMemory?: number }).deviceMemory ?? null,
  });
  new WebSDK({
    endpoint,
    serviceName: "opfs-lsm-demo",
    serviceVersion: import.meta.env.VITE_EVERR_SERVICE_VERSION,
    deploymentEnvironment: import.meta.env.MODE,
    ingestKey: import.meta.env.VITE_EVERR_PUBLIC_INGEST_KEY,
    dev: import.meta.env.DEV,
    // Redact's `nano` preset has no error boundaries. It sends a render error to `reportError`, which `errors()`
    // records.
    instrumentations: [errors(), pageviews(), interactions(), webVitals(), network(), (ctx) => void (emit = ctx.emit)],
  });
}

export const record = ({ name, ms, attributes }: Kpi) => emit?.(name, { "linearlite.duration_ms": ms, ...attributes });

export const report = (err: unknown) => {
  if (endpoint) captureError(err);
};
