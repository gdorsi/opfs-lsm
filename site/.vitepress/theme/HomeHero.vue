<script setup lang="ts">
import { useData } from "vitepress";
import { VPButton } from "vitepress/theme";
import { computed } from "vue";
import HomeDemo from "./HomeDemo.vue";

/**
 * The home page's first screen: what opfs-lsm is, the ways in, and LinearLite running on it in this tab. The copy and
 * the actions are the page's `intro` frontmatter.
 */
type Action = { theme: "brand" | "alt"; text: string; link: string };

const { frontmatter, site } = useData();
const intro = computed(() => frontmatter.value.intro as { title: string; actions: Action[] });
</script>

<template>
  <section class="home-hero">
    <div class="home-hero-head">
      <div>
        <p class="home-hero-name">{{ site.title }}</p>
        <h1 class="home-hero-title">{{ intro.title }}</h1>
      </div>
      <div class="home-hero-actions">
        <VPButton
          v-for="action in intro.actions"
          :key="action.link"
          tag="a"
          size="medium"
          :theme="action.theme"
          :text="action.text"
          :href="action.link"
        />
      </div>
    </div>
    <HomeDemo />
  </section>
</template>
