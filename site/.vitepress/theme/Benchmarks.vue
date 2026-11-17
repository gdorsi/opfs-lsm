<script setup lang="ts">
import BenchGroup from "./BenchGroup.vue";
import { ONE, ticks, type Chart } from "./bench.ts";

/**
 * The home page's benchmarks: a card per baseline, IndexedDB and then SQLite on OPFS, all on one log scale of how
 * many times faster opfs-lsm is. Every value and ratio is the page's frontmatter, which the site check holds to
 * docs/benchmarks.md, so a loss shows as plainly as a win.
 */
defineProps<{ charts: Chart[] }>();
</script>

<template>
  <div class="bench" :style="{ '--one': `${ONE}%` }">
    <section v-for="c in charts" :key="c.title" class="bench-card">
      <div class="bench-axis">
        <h3 class="bench-card-title">{{ c.title }}</h3>
        <div class="bench-plot bench-axis-plot" aria-hidden="true">
          <div class="bench-inner">
            <span class="bench-side bench-side-slow"><span class="bench-mark" data-tone="warning" />slower</span>
            <span class="bench-side bench-side-fast">faster<span class="bench-mark" data-tone="success" /></span>
            <span v-for="t in ticks" :key="t.label" class="bench-tick" :style="{ left: `${t.x}%` }">{{ t.label }}</span>
          </div>
        </div>
        <span class="bench-axis-values" aria-hidden="true">opfs-lsm vs {{ c.theirs }}</span>
      </div>
      <BenchGroup v-for="g in c.groups" :key="g.title" :group="g" />
    </section>
  </div>
</template>
