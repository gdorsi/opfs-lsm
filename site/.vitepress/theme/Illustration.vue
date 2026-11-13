<script setup lang="ts">
import { useData } from "vitepress";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { SIZES, STILLS, type SceneName } from "../../stageshow/sizes.ts";
import { FIGURES } from "./figures.ts";

/**
 * One illustration from `site/stageshow`. They are React components, so this mounts a React root in the browser
 * and renders nothing on the server but a box of the stage's size, which keeps the page from moving when it loads.
 */
/**
 * `full`: the illustration is as wide as the page, not one column of a claim.
 * `label`: what a screen reader reads, by default the one in `FIGURES`.
 */
const props = defineProps<{ name: SceneName; label?: string; data?: Record<string, unknown>; full?: boolean }>();

const { isDark } = useData();
const host = ref<HTMLElement>();
const run = ref(0);
const size = computed(() => SIZES[props.name]);
let scene: { render(props: Record<string, unknown>): void; unmount(): void } | undefined;

const render = () => scene?.render({ ...props.data, theme: isDark.value ? "dark" : "light", run: run.value });

onMounted(async () => {
  const { mount } = await import("../../stageshow/mount.tsx");
  if (!host.value) return;
  scene = mount(host.value, props.name);
  render();
});
watch([isDark, run], render);
onBeforeUnmount(() => scene?.unmount());
</script>

<template>
  <figure class="illustration" :class="{ full }">
    <div
      ref="host"
      class="illustration-stage"
      role="img"
      :aria-label="label ?? FIGURES[name]"
      :style="{
        '--wide': `${size.wide[0]} / ${size.wide[1]}`,
        '--wide-width': `${size.wide[0]}px`,
        '--compact': `${size.compact[0]} / ${size.compact[1]}`,
        '--compact-width': `${size.compact[0]}px`,
      }"
    />
    <button v-if="!STILLS.has(name)" class="illustration-replay" type="button" @click="run++">Replay</button>
  </figure>
</template>
