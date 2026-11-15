import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  server: { host: "127.0.0.1", port: Number(process.env.PORT ?? 4184), strictPort: false },
  // kv's SharedWorker loads its wasm glue with dynamic import(), which classic workers can't resolve.
  worker: { format: "es" },
  optimizeDeps: {
    // kv: keep the worker and engine.wasm next to their module so `new URL("…", import.meta.url)` finds them.
    // @automerge/automerge: the dep optimizer copies its wasm-bindgen glue while the .wasm import still binds the
    // original module, and the page dies with "Uncaught #<Exception>".
    exclude: ["@opfs-lsm/kv", "@opfs-lsm/fate", "@opfs-lsm/automerge", "@automerge/automerge"],
  },
  plugins: [tanstackStart(), react()],
});
