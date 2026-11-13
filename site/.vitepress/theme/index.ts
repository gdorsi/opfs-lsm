import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import HomeDemo from "./HomeDemo.vue";
import Illustration from "./Illustration.vue";
import "./home.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("HomeDemo", HomeDemo);
    app.component("Illustration", Illustration);
  },
} satisfies Theme;
