import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import HomeDemo from "./HomeDemo.vue";
import Illustration from "./Illustration.vue";
import Layout from "./Layout.vue";
import "./home.css";
import "./doc.css";

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component("HomeDemo", HomeDemo);
    app.component("Illustration", Illustration);
  },
} satisfies Theme;
