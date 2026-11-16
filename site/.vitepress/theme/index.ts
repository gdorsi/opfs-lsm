import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import Illustration from "./Illustration.vue";
import Layout from "./Layout.vue";
import UseCases from "./UseCases.vue";
import "./home.css";
import "./doc.css";

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component("Illustration", Illustration);
    app.component("UseCases", UseCases);
  },
} satisfies Theme;
