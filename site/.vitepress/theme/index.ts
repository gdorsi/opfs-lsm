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
  },
} satisfies Theme;
