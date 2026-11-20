import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import Adapters from "./Adapters.vue";
import Benchmarks from "./Benchmarks.vue";
import Illustration from "./Illustration.vue";
import Layout from "./Layout.vue";
import "./home.css";
import "./doc.css";

const withoutTelemetry = () => undefined;

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component("Adapters", Adapters);
    app.component("Benchmarks", Benchmarks);
    app.component("Illustration", Illustration);
    if (import.meta.env.SSR) return;
    // An earlier build kept the SDK's visitor id and session here.
    try {
      localStorage.removeItem("everr.visitor.id");
      localStorage.removeItem("everr.session");
    } catch {}
    if (!import.meta.env.VITE_EVERR_INGEST_ENDPOINT) return;
    if ((navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl === true || navigator.doNotTrack === "1") return;
    // A click id such as `fbclid` leaves the address bar before the SDK reads it. The demo's frame sends no referrer.
    const url = new URL(location.href);
    url.search = new URLSearchParams([...url.searchParams].filter(([key]) => key.startsWith("utm_"))).toString();
    if (url.href !== location.href) history.replaceState(history.state, "", url);
    void import("./telemetry.ts").then((t) => t.startTelemetry(app), withoutTelemetry);
  },
} satisfies Theme;
