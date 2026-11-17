<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ratioTone } from "../tone.ts";
import { LINE, pairText, ticks, xOf, type Group } from "./bench.ts";

/**
 * One group of a benchmark card: its head, then a row per result. A bar runs from the 1× line to the result's ratio,
 * right when opfs-lsm is faster and left when it is slower, with the ratio at its end and the two values on the right.
 * The page renders the bars drawn. A group that starts below the screen folds them back to the line once mounted and
 * grows them, one row after the next, when it scrolls into view.
 */
const props = defineProps<{ group: Group }>();

const rows = computed(() =>
  props.group.rows.map((r) => {
    const [ours, theirs] = props.group.stores;
    return {
      ...r,
      x: xOf(Number.parseFloat(r.ratio)),
      tone: ratioTone(r.ratio),
      shown: pairText(r.ours, r.theirs),
      label: `${r.measure}: ${r.ours} on ${ours} against ${r.theirs} on ${theirs}, ${r.ratio} as fast.`,
    };
  }),
);

const root = ref<HTMLElement>();
const folded = ref(false);
let observer: IntersectionObserver | undefined;

onMounted(() => {
  const el = root.value;
  if (!el || el.getBoundingClientRect().top < innerHeight) return;
  folded.value = true;
  observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry?.isIntersecting) return;
      observer?.disconnect();
      folded.value = false;
    },
    { threshold: 0.2 },
  );
  observer.observe(el);
});
onBeforeUnmount(() => observer?.disconnect());

/** The ratio sits past the bar's end: left of a bar that goes left, just right of the line's dot when even. */
function tipAt(r: (typeof rows.value)[number]) {
  if (r.tone === "warning") return { right: `calc(${100 - r.x}% + 6px)` };
  return { left: r.tone === "neutral" ? `calc(${LINE}% + 10px)` : `calc(${r.x}% + 6px)` };
}
</script>

<template>
  <section ref="root" class="bench-group" :data-folded="folded || undefined">
    <header class="bench-group-head">
      <h4 class="bench-group-title">{{ group.title }} <span>{{ group.versus }}</span></h4>
      <p v-if="group.setup" class="bench-group-setup">{{ group.setup }}</p>
    </header>
    <ul class="bench-rows">
      <li v-for="(r, i) in rows" :key="r.measure" class="bench-row" :style="{ '--i': i }">
        <span class="bench-sr">{{ r.label }}</span>
        <span class="bench-measure" aria-hidden="true">{{ r.measure }}</span>
        <div class="bench-plot" aria-hidden="true">
          <div class="bench-inner">
            <span
              v-for="t in ticks"
              :key="t.label"
              class="bench-grid"
              :data-one="t.x === LINE || undefined"
              :style="{ left: `${t.x}%` }"
            />
            <span
              class="bench-bar"
              :data-tone="r.tone"
              :style="{ '--cut-left': `${Math.min(r.x, LINE)}%`, '--cut-right': `${100 - Math.max(r.x, LINE)}%` }"
            />
            <span v-if="r.tone === 'neutral'" class="bench-dot" />
            <span class="bench-tip" :style="tipAt(r)">{{ r.ratio }}</span>
          </div>
        </div>
        <span class="bench-values" aria-hidden="true">{{ r.shown }}</span>
      </li>
    </ul>
    <p v-if="group.note" class="bench-note">{{ group.note }}</p>
  </section>
</template>
