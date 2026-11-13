import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Writes /sw.js into the client build: src/service-worker.js with the build's file list in front. The cache name
 * is a hash of that list, so each build gets its own cache.
 */
function serviceWorker(): Plugin {
  return {
    name: "linearlite:service-worker",
    applyToEnvironment: (environment) => environment.name === "client",
    writeBundle(options) {
      const dir = options.dir!;
      const files = readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => `/${relative(dir, join(entry.parentPath, entry.name)).replaceAll("\\", "/")}`)
        .filter((path) => path !== "/sw.js")
        .sort();
      const cache = `linearlite-fate-${createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 12)}`;
      const source = readFileSync(join(this.environment.config.root, "src/service-worker.js"), "utf8");
      writeFileSync(join(dir, "sw.js"), `const CACHE = ${JSON.stringify(cache)};\nconst FILES = ${JSON.stringify(files)};\n${source}`);
    },
  };
}

export default defineConfig({
  server: { host: "127.0.0.1", port: Number(process.env.PORT ?? 4181), strictPort: false, watch: { usePolling: !!process.env.POLL } },
  // kv's SharedWorker loads its wasm glue with dynamic import(), which classic workers can't resolve.
  worker: { format: "es" },
  // Keep kv as real files so `new URL("…", import.meta.url)` finds the worker and wasm next to them.
  optimizeDeps: { exclude: ["@opfs-lsm/kv", "@opfs-lsm/fate"] },
  plugins: [tanstackStart(), react(), serviceWorker()],
});
