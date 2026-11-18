<script setup lang="ts">
import { inBrowser } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { watchPostEffect } from "vue";
import { usePageDark } from "./dark.ts";
import HomeHero from "./HomeHero.vue";
import "./layout.css";

/**
 * The default layout with two additions: an "alpha" tag after the site title on every page, and the home page's hero.
 * The default theme sets the `dark` class from the reader's appearance; the landing page keeps it on.
 */
const dark = usePageDark();
watchPostEffect(() => {
  if (inBrowser) document.documentElement.classList.toggle("dark", dark.value);
});
</script>

<template>
  <DefaultTheme.Layout>
    <template #nav-bar-title-after>
      <span class="alpha-tag">alpha</span>
    </template>
    <template #home-hero-before>
      <HomeHero />
    </template>
  </DefaultTheme.Layout>
</template>
