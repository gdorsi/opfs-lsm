import { defineConfig } from "vitest/config";

export default defineConfig({
  assetsInclude: ["**/*.wasm"],
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    globalSetup: ["./tests/global-setup.ts"],
    // vitest keeps one core free, which leaves a single worker on a 2-vCPU CI runner.
    ...(process.env.CI ? { maxWorkers: 2 } : {}),
    // The checked twin calls into JavaScript on every memory access.
    ...(process.env.KV_ENGINE === "checked" ? { testTimeout: 60_000 } : {}),
  },
});
