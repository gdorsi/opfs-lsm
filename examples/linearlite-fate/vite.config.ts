import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  server: { host: "127.0.0.1", port: Number(process.env.PORT ?? 4181), strictPort: false, watch: { usePolling: !!process.env.POLL } },
  // kv's SharedWorker loads its wasm glue with dynamic import(), which classic workers can't resolve.
  worker: { format: "es" },
  // Keep kv as real files so `new URL("…", import.meta.url)` finds the worker and wasm next to them.
  optimizeDeps: { exclude: ["@opfs-lsm/kv", "@opfs-lsm/fate"] },
  plugins: [tanstackStart(), react()],
});
