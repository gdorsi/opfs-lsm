<script setup lang="ts">
import { useData } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { computed } from "vue";
import Illustration from "./Illustration.vue";
import "./layout.css";

/**
 * The default layout with two additions: an "alpha" tag after the site title on every page, and the home page's
 * hero illustration. The illustration's size comes from the home page's frontmatter, which the build checks
 * against README.md.
 */
const { frontmatter } = useData();
const size = computed(() => frontmatter.value.size as { main: string } | undefined);
</script>

<template>
  <DefaultTheme.Layout>
    <template #nav-bar-title-after>
      <span class="alpha-tag">alpha</span>
    </template>
    <template #home-hero-image>
      <Illustration
        v-if="size"
        name="sync"
        class="hero-illustration"
        :data="size"
        :label="`An app's issue list syncs two new issues. Each is written to @opfs-lsm/kv under its key and acked, then the SharedWorker flushes them to OPFS. kv adds ${size.main} to the main bundle.`"
      />
    </template>
  </DefaultTheme.Layout>
</template>
