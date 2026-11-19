import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import Adapters from "./Adapters.vue";
import Benchmarks from "./Benchmarks.vue";
import Illustration from "./Illustration.vue";
import Layout from "./Layout.vue";
import "./home.css";
import "./doc.css";

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component("Adapters", Adapters);
    app.component("Benchmarks", Benchmarks);
    app.component("Illustration", Illustration);
    if (!import.meta.env.SSR && import.meta.env.VITE_EVERR_INGEST_ENDPOINT) void import("./telemetry.ts").then((t) => t.startTelemetry(app));
  },
} satisfies Theme;
