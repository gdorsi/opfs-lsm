<script setup lang="ts">
import { useData } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { computed } from "vue";
import Illustration from "./Illustration.vue";
import "./layout.css";

/**
 * The default layout with two additions: an "alpha" tag after the site title on every page, and the home page's
 * hero illustration. The hero shows the best read of the TanStack DB benchmarks, `read` in the home page's
 * frontmatter, which the build checks against README.md.
 */
type Read = { framework: string; workload: string; baseline: string; other: string; kv: string; ratio: string };

const { frontmatter } = useData();
const read = computed(() => frontmatter.value.read as Read | undefined);
</script>

<template>
  <DefaultTheme.Layout>
    <template #nav-bar-title-after>
      <span class="alpha-tag">alpha</span>
    </template>
    <template #home-hero-image>
      <Illustration
        v-if="read"
        name="reopen"
        class="hero-illustration"
        :data="read"
        :label="`An issue tracker reopens and loads its issues from disk through opfs-lsm, with no network request. In the ${read.framework} benchmark, ${read.workload.toLowerCase()}, opfs-lsm reads ${read.kv} and ${read.baseline} ${read.other}: ${read.ratio} faster.`"
      />
    </template>
  </DefaultTheme.Layout>
</template>
