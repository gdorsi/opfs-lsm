interface ImportMetaEnv {
  /** The OTLP base URL telemetry goes to. A build without it constructs no client and holds none of its code. */
  readonly VITE_EVERR_INGEST_ENDPOINT?: string;
  /** The public ingest key, bound to the origins the app is served from. Unset for a local collector. */
  readonly VITE_EVERR_PUBLIC_INGEST_KEY?: string;
  readonly VITE_EVERR_SERVICE_VERSION?: string;
}
