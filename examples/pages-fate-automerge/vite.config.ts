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
    name: "pages:service-worker",
    applyToEnvironment: (environment) => environment.name === "client",
    writeBundle(options) {
      const dir = options.dir!;
      const files = readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => `/${relative(dir, join(entry.parentPath, entry.name)).replaceAll("\\", "/")}`)
        .filter((path) => path !== "/sw.js")
        .sort();
      const cache = `pages-fate-automerge-${createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 12)}`;
      const source = readFileSync(join(this.environment.config.root, "src/service-worker.js"), "utf8");
      writeFileSync(join(dir, "sw.js"), `const CACHE = ${JSON.stringify(cache)};\nconst FILES = ${JSON.stringify(files)};\n${source}`);
    },
  };
}

export default defineConfig({
  server: { host: "127.0.0.1", port: Number(process.env.PORT ?? 4184), strictPort: false },
  preview: { host: "127.0.0.1", port: Number(process.env.PORT ?? 4184), strictPort: false },
  optimizeDeps: {
    // @automerge/automerge: the dep optimizer copies its wasm-bindgen glue while the .wasm import still binds the
    // original module, and the page dies with "Uncaught #<Exception>".
    exclude: ["@automerge/automerge"],
  },
  plugins: [tanstackStart(), react(), serviceWorker()],
});
