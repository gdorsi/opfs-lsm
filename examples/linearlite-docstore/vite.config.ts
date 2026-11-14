import { redact } from "@tanstack/redact/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Static files with a relative base, so the build runs under any path. The docs site serves it under `demo/`. */
export default defineConfig({
  base: "./",
  // React's API, with TanStack Redact in place of react and react-dom in the bundle. The smallest preset, plus portals
  // for the menus, the only optional feature the app uses.
  plugins: [react(), redact({ preset: "nano", features: { portal: true } })],
  server: { host: "127.0.0.1", port: Number(process.env.PORT ?? 4182), strictPort: false },
  // Module workers: kv's SharedWorker loads its wasm glue with a dynamic import, which a classic worker cannot do.
  worker: { format: "es" },
  // Serve the workspace packages as real files, so kv finds `engine.wasm` next to its own module.
  optimizeDeps: { exclude: ["@opfs-lsm/kv", "@opfs-lsm/docstore"] },
});
