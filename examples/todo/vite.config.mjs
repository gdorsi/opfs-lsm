import react from "@vitejs/plugin-react";
import { redact } from "@tanstack/redact/vite";
import { defineConfig } from "vite";

// Client-only app: React replaces every optional feature with plain hooks and
// voids (portals, context, Suspense, hydration …), so the smallest runtime
// (nano) is what it needs. The plugin aliases react/react-dom to that runtime.
const useRedact = process.env.TODO_REDACT !== "0";

const port = Number(process.env.TODO_PORT ?? 4173);
const open = process.env.TODO_NO_OPEN === "1" ? false : true;

export default defineConfig({
  server: { host: "127.0.0.1", port, open, strictPort: false },
  preview: { host: "127.0.0.1", port, open },
  // Module worker: the SharedWorker boot uses dynamic import() for the wasm
  // glue, which classic (iife) workers cannot resolve.
  worker: { format: "es" },
  plugins: [
    react(),
    ...(useRedact
      ? [redact({ preset: "nano" })]
      : // TODO_REDACT=0 builds plain React for the bundle-size comparison.
        []),
  ],
  // Serve the workspace packages as real files so the runtime `new URL(...,
  // import.meta.url)` that loads `wasm/engine.wasm` keeps its true
  // location instead of landing on an esbuild prebundle.
  optimizeDeps: { exclude: ["@opfs-lsm/kv", "@opfs-lsm/collections"] },
});
