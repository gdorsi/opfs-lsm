<script setup lang="ts">
import DefaultTheme from "vitepress/theme";
import "./layout.css";

/** The default layout with an "alpha" tag after the site title, on every page. */
</script>

<template>
  <DefaultTheme.Layout>
    <template #nav-bar-title-after>
      <span class="alpha-tag">alpha</span>
    </template>
  </DefaultTheme.Layout>
</template>
