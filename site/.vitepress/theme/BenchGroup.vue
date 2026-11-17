<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ratioTone } from "../tone.ts";
import { at, ONE, ticks, values, type Group } from "./bench.ts";

/**
 * One group of a benchmark card: its head, then a row per result. A bar runs from the 1× line to the result's ratio,
 * right when opfs-lsm is faster and left when it is slower, with the ratio at its end and the two values on the right.
 * The bars grow out of the line the first time the group scrolls into view, one row after the next.
 */
const props = defineProps<{ group: Group }>();

const rows = computed(() =>
  props.group.rows.map((r) => {
    const [ours, theirs] = props.group.stores;
    return {
      ...r,
      x: at(Number.parseFloat(r.ratio)),
      tone: ratioTone(r.ratio),
      values: values(r.ours, r.theirs),
      label: `${r.measure}: ${r.ours} on ${ours}, ${r.theirs} on ${theirs}, ${r.ratio}.`,
    };
  }),
);

const root = ref<HTMLElement>();
const shown = ref(false);
/** Holds while the bars first grow, so only that entrance is staggered. */
const entering = ref(false);
let observer: IntersectionObserver | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

onMounted(() => {
  if (!root.value) return;
  observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry?.isIntersecting) return;
      observer?.disconnect();
      entering.value = true;
      requestAnimationFrame(() => (shown.value = true));
      timer = setTimeout(() => (entering.value = false), 1400);
    },
    { threshold: 0.2 },
  );
  observer.observe(root.value);
});
onBeforeUnmount(() => {
  observer?.disconnect();
  clearTimeout(timer);
});

const delay = (i: number, extra = 0) => (entering.value ? `${i * 24 + extra}ms` : "0ms");

/** The ratio sits past the bar's end: left of a bar that goes left, just right of the line's dot when even. */
function tip(r: (typeof rows.value)[number], i: number) {
  const transitionDelay = delay(i, 160);
  if (r.tone === "warning") return { right: `calc(${100 - r.x}% + 6px)`, transitionDelay };
  return { left: r.tone === "neutral" ? `calc(${ONE}% + 10px)` : `calc(${r.x}% + 6px)`, transitionDelay };
}
</script>

<template>
  <section ref="root" class="bench-group" :data-shown="shown || undefined">
    <header class="bench-group-head">
      <h4 class="bench-group-title">{{ group.title }} <span>{{ group.versus }}</span></h4>
      <p v-if="group.setup" class="bench-group-setup">{{ group.setup }}</p>
    </header>
    <ul class="bench-rows">
      <li v-for="(r, i) in rows" :key="r.measure" class="bench-row">
        <span class="bench-sr">{{ r.label }}</span>
        <span class="bench-measure" aria-hidden="true">{{ r.measure }}</span>
        <div class="bench-plot" aria-hidden="true">
          <div class="bench-inner">
            <span
              v-for="t in ticks"
              :key="t.label"
              class="bench-grid"
              :data-one="t.x === ONE || undefined"
              :style="{ left: `${t.x}%` }"
            />
            <span
              class="bench-bar"
              :data-tone="r.tone"
              :style="{ '--l': `${Math.min(r.x, ONE)}%`, '--r': `${100 - Math.max(r.x, ONE)}%`, transitionDelay: delay(i) }"
            />
            <span v-if="r.tone === 'neutral'" class="bench-dot" :style="{ transitionDelay: delay(i, 160) }" />
            <span class="bench-tip" :style="tip(r, i)">{{ r.ratio }}</span>
          </div>
        </div>
        <span class="bench-values" aria-hidden="true">{{ r.values }}</span>
      </li>
    </ul>
    <p v-if="group.note" class="bench-note">{{ group.note }}</p>
  </section>
</template>
