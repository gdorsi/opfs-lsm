import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  server: { host: "127.0.0.1", port: Number(process.env.PORT ?? 4183) },
  plugins: [tanstackStart(), react()],
});
