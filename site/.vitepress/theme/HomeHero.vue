<script setup lang="ts">
import { useData, withBase } from "vitepress";
import { computed } from "vue";
import AlphaNotice from "./AlphaNotice.vue";
import HomeDemo from "./HomeDemo.vue";

/**
 * The home page's first screen: the name line, what opfs-lsm is, and LinearLite running on it in this tab. The copy, the
 * menu and the alpha notice are the page's `intro` frontmatter.
 */
type Intro = {
  title: string;
  menu: { text: string; link: string }[];
  notice: { title: string; body: string; link: string };
};

const { frontmatter, site } = useData();
const intro = computed(() => frontmatter.value.intro as Intro);
const menu = computed(() =>
  intro.value.menu.map(({ text, link }) => {
    const external = /^https?:/.test(link);
    return { text, external, href: external ? link : withBase(link) };
  }),
);
</script>

<template>
  <section class="home-hero">
    <div class="home-line">
      <div class="home-line-brand">
        <span class="home-line-name">{{ site.title }}</span>
        <AlphaNotice :notice="intro.notice" />
      </div>
      <nav class="home-line-menu" aria-label="Main">
        <a
          v-for="item in menu"
          :key="item.href"
          :href="item.href"
          :target="item.external ? '_blank' : undefined"
          :rel="item.external ? 'noreferrer' : undefined"
        >
          {{ item.text }}<span v-if="item.external" aria-hidden="true"> ↗</span>
        </a>
      </nav>
    </div>
    <h1 class="home-hero-title">{{ intro.title }}</h1>
    <HomeDemo />
  </section>
</template>
