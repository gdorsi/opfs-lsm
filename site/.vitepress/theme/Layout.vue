<script setup lang="ts">
import DefaultTheme from "vitepress/theme";
import HomeHero from "./HomeHero.vue";
import "./layout.css";

/** The default layout with two additions: an "alpha" tag after the site title on every page, and the home page's hero. */
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
