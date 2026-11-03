import { defineConfig } from "vitest/config";

export default defineConfig({
  assetsInclude: ["**/*.wasm"],
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    server: {
      deps: {
        // Allow vitest to transform the wasm-pack bundler output.
        inline: [/engine_wasm/],
      },
    },
  },
});
