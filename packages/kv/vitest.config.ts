import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  assetsInclude: ["**/*.wasm"],
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    exclude: [
      ...configDefaults.exclude,
      "tests/sim/{check-database,corruption,crash-enum,io-error,model,multi-handle,regressions}.test.ts",
    ],
  },
});
