import { captureError, errors, interactions, network, pageviews, performance, WebSDK } from "@everr/otel-web";
import type { App } from "vue";

export function startTelemetry(app: App): void {
  new WebSDK({
    endpoint: import.meta.env.VITE_EVERR_INGEST_ENDPOINT,
    serviceName: "opfs-lsm-site",
    serviceVersion: import.meta.env.VITE_EVERR_SERVICE_VERSION,
    deploymentEnvironment: import.meta.env.MODE,
    ingestKey: import.meta.env.VITE_EVERR_PUBLIC_INGEST_KEY,
    dev: import.meta.env.DEV,
    instrumentations: [errors(), pageviews(), interactions(), performance(), network()],
  });
  // In production Vue only logs an error a component throws, so it never reaches `errors()`.
  app.config.errorHandler = (err) => {
    console.error(err);
    captureError(err);
  };
}
