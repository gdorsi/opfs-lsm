import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** LinearLite as static files with no server: `demo/`. The base is relative, so the build runs under any path. */
export default defineConfig({
  root: "demo",
  base: "./",
  server: { host: "127.0.0.1", port: Number(process.env.PORT ?? 4181), strictPort: false },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@opfs-lsm/kv", "@opfs-lsm/docstore", "@opfs-lsm/tanstack-db"] },
  build: { outDir: "../dist-demo", emptyOutDir: true },
  plugins: [react()],
});
