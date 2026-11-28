import { defineConfig } from "vitest/config";

export default defineConfig({
  // Workspace packages resolve to their source, so a kv change needs no kv build first.
  ssr: { resolve: { conditions: ["opfs-lsm-source"] } },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
  },
});
