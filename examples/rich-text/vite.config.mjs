import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";

const port = Number(process.env.RICH_TEXT_PORT ?? 4175);

export default defineConfig({
  plugins: [wasm(), react()],
  worker: {
    format: "es",
    plugins: () => [wasm()],
  },
  optimizeDeps: {
    exclude: ["@opfs-lsm/kv"],
  },
  server: {
    host: "127.0.0.1",
    port,
    open: false,
    strictPort: false,
  },
  preview: {
    host: "127.0.0.1",
    port,
    open: false,
    strictPort: false,
  },
});
