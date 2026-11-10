import { defineConfig } from "vitest/config";

export default defineConfig({
  assetsInclude: ["**/*.wasm"],
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    // vitest keeps one core free, which leaves a single worker on a 2-vCPU CI runner.
    ...(process.env.CI ? { maxWorkers: 2 } : {}),
  },
});
