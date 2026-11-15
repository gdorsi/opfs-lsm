<script setup lang="ts">
import DefaultTheme from "vitepress/theme";
import Illustration from "./Illustration.vue";
import "./layout.css";

/** The default layout with two additions: an "alpha" tag after the site title on every page, and the home page's hero illustration. */
</script>

<template>
  <DefaultTheme.Layout>
    <template #nav-bar-title-after>
      <span class="alpha-tag">alpha</span>
    </template>
    <template #home-hero-image>
      <Illustration name="features" class="hero-illustration" />
    </template>
  </DefaultTheme.Layout>
</template>
