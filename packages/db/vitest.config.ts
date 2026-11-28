import { defineConfig } from "vitest/config";

export default defineConfig({
  // Workspace packages resolve to their source, so a kv change needs no kv build first. `browser` picks Solid's client
  // build, the reactive one: under Node's own conditions `solid-js` is its server build, which runs each memo once.
  ssr: { resolve: { conditions: ["opfs-lsm-source", "browser", "development"] } },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    // Inlined, so the conditions above apply to it.
    server: { deps: { inline: [/solid-js/, /@solidjs\/signals/] } },
  },
});
