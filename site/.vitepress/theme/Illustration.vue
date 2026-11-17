<script setup lang="ts">
import { useData } from "vitepress";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { SIZES, STILLS, type SceneName } from "../../stageshow/sizes.ts";
import { FIGURES, STEPS } from "./figures.ts";

/**
 * One illustration from `site/stageshow`. They are React components, so this mounts a React root in the browser
 * and renders nothing on the server but a box of the stage's size, which keeps the page from moving when it loads.
 */
/**
 * `full`: the illustration is as wide as the page, not one column of a claim.
 * `label`: what a screen reader reads, by default the one in `FIGURES`.
 * An illustration with an entry in `STEPS` is clicked through: its caption and Back and Next buttons sit under it
 * as page elements, because the stage is one `role="img"` and nothing inside it is reachable.
 */
const props = defineProps<{ name: SceneName; label?: string; data?: Record<string, unknown>; full?: boolean }>();

const { isDark } = useData();
const host = ref<HTMLElement>();
const run = ref(0);
const step = ref(0);
const size = computed(() => SIZES[props.name]);
const steps = computed(() => STEPS[props.name]);
const last = computed(() => step.value === (steps.value?.length ?? 1) - 1);
const vars = computed(() => ({
  "--wide": `${size.value.wide[0]} / ${size.value.wide[1]}`,
  "--wide-width": `${size.value.wide[0]}px`,
  "--compact": `${size.value.compact[0]} / ${size.value.compact[1]}`,
  "--compact-width": `${size.value.compact[0]}px`,
}));
let scene: { render(props: Record<string, unknown>): void; unmount(): void } | undefined;

const render = () => scene?.render({ ...props.data, theme: isDark.value ? "dark" : "light", run: run.value, step: step.value });

const back = () => {
  if (step.value > 0) step.value--;
};
const next = () => {
  step.value = last.value ? 0 : step.value + 1;
};
// Left and Right step while focus is anywhere in the figure. Right stops at the last step: only Start over wraps.
const onKey = (e: KeyboardEvent) => {
  if (!steps.value || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (e.key === "ArrowRight" && !last.value) next();
  else if (e.key === "ArrowLeft") back();
  else return;
  e.preventDefault();
};

onMounted(async () => {
  const { mount } = await import("../../stageshow/mount.tsx");
  if (!host.value) return;
  scene = mount(host.value, props.name);
  render();
});
// A page that passes new data (the use cases picking a case) redraws the scene in place.
watch([isDark, run, step, () => props.data], render, { deep: true });
onBeforeUnmount(() => scene?.unmount());
</script>

<template>
  <figure class="illustration" :class="{ full, stepped: !!steps }" :tabindex="steps ? -1 : undefined" @keydown="onKey">
    <div ref="host" class="illustration-stage" role="img" :aria-label="label ?? FIGURES[name]" :style="vars" />
    <div v-if="steps" class="illustration-steps" :style="vars">
      <div class="illustration-caption">
        <div class="illustration-caption-live" aria-live="polite">
          <span class="illustration-sr">Step {{ step + 1 }} of {{ steps.length }}. </span>{{ steps[step] }}
        </div>
        <!-- Every caption laid out in the same cell, unseen, so the caption's box is as tall as the longest and the page below never moves. -->
        <span v-for="text in steps" :key="text" class="illustration-caption-size" aria-hidden="true">{{ text }}</span>
      </div>
      <div class="illustration-nav">
        <span class="illustration-count">{{ step + 1 }} of {{ steps.length }}</span>
        <button class="illustration-step" type="button" :aria-disabled="step === 0" @click="back">Back</button>
        <button class="illustration-step illustration-step-next" type="button" @click="next">
          {{ last ? "Start over" : "Next" }}
        </button>
      </div>
    </div>
    <button v-else-if="!STILLS.has(name)" class="illustration-replay" type="button" @click="run++">Replay</button>
  </figure>
</template>
