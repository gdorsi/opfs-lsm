<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { createPlayhead } from "../../stageshow/playhead.ts";
import { SIZES, type SceneName } from "../../stageshow/sizes.ts";
import { usePageDark } from "./dark.ts";
import { CHAPTERS, FIGURES } from "./figures.ts";
import PlayerBar from "./PlayerBar.vue";

/**
 * One illustration from `site/stageshow`. They are React components, so this mounts a React root in the browser
 * and renders nothing on the server but a box of the stage's size, which keeps the page from moving when it loads.
 */
/**
 * `full`: the illustration is as wide as the page, not one column of a claim.
 * An illustration with an entry in `CHAPTERS` plays with a player: pause and a timeline of the chapters on the
 * stage's bottom edge, and the chapters' titles and details, in a list beside the stage on wide screens and as the
 * playing chapter's caption under it otherwise. They are page elements, because the stage is one `role="img"` and
 * nothing inside it is reachable.
 */
const props = defineProps<{ name: SceneName; full?: boolean }>();

const dark = usePageDark();
const host = ref<HTMLElement>();
const run = ref(0);
const size = computed(() => SIZES[props.name]);
const chapters = computed(() => CHAPTERS[props.name]);
const vars = computed(() => ({
  "--wide": `${size.value.wide[0]} / ${size.value.wide[1]}`,
  "--wide-width": `${size.value.wide[0]}px`,
  "--compact": `${size.value.compact[0]} / ${size.value.compact[1]}`,
  "--compact-width": `${size.value.compact[0]}px`,
}));
let scene: { render(props: Record<string, unknown>): void; unmount(): void } | undefined;
let near: IntersectionObserver | undefined;

// The player. The scene plays from `jump` and reports each chapter it starts; `clock` holds the playing chapter and
// when it started, read by the timeline every frame, and `current` the same chapter for the page.
const playhead = markRaw(createPlayhead());
const clock = markRaw({ chapter: 0, startedAt: Number.POSITIVE_INFINITY });
const current = ref(0);
const jump = shallowRef({ chapter: 0 });
const paused = ref(false);
const still = ref(false);
const onChapter = (chapter: number, startedAt: number) => {
  clock.chapter = chapter;
  clock.startedAt = startedAt;
  current.value = chapter;
};
const go = (chapter: number) => {
  playhead.setPaused(false);
  paused.value = false;
  onChapter(chapter, playhead.now());
  jump.value = { chapter };
};
const toggle = () => {
  paused.value = !paused.value;
  playhead.setPaused(paused.value);
};

let motion: MediaQueryList | undefined;
const onMotion = () => (still.value = !!motion?.matches);

const render = () =>
  scene?.render({
    theme: dark.value ? "dark" : "light",
    run: run.value,
    ...(chapters.value && { jump: jump.value, playhead, onChapter }),
  });

onMounted(async () => {
  if (chapters.value) {
    motion = matchMedia("(prefers-reduced-motion: reduce)");
    onMotion();
    motion.addEventListener("change", onMotion);
  }
  // The scenes and React are loaded when the stage is within a screen of the viewport, so a page that opens above
  // it does not pay for them at its start.
  near = new IntersectionObserver(
    async (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      near?.disconnect();
      const { mount } = await import("../../stageshow/mount.tsx");
      if (!host.value) return;
      scene = mount(host.value, props.name);
      render();
    },
    { rootMargin: "100% 0px" },
  );
  near.observe(host.value!);
});
watch([dark, run, jump], render);
onBeforeUnmount(() => {
  motion?.removeEventListener("change", onMotion);
  near?.disconnect();
  scene?.unmount();
});
</script>

<template>
  <figure v-if="chapters" class="illustration player" :class="{ full }" :style="vars">
    <div class="player-row">
      <div class="player-main">
        <div ref="host" class="illustration-stage" role="img" :aria-label="FIGURES[name]" />
        <PlayerBar
          :chapters="chapters"
          :playhead="playhead"
          :clock="clock"
          :current="current"
          :paused="paused"
          :still="still"
          @toggle="toggle"
          @jump="go"
        />
      </div>
      <!-- On wide screens, every chapter beside the stage, the playing one with its detail. -->
      <nav class="player-index" aria-label="Chapters">
        <ol>
          <li v-for="(chapter, i) in chapters" :key="chapter.label">
            <button type="button" :aria-current="i === current ? 'step' : undefined" @click="go(i)">
              <span class="player-index-mark" :style="{ background: `var(--player-${i % 7})` }" aria-hidden="true" />
              <span class="player-index-title">{{ chapter.title }}</span>
              <span class="player-index-detail"><span>{{ chapter.detail }}</span></span>
            </button>
          </li>
        </ol>
      </nav>
    </div>
    <!-- Narrower, the playing chapter, under the controls. Every chapter is laid out in the same cell, unseen, so the
         box is as tall as the longest and the page below never moves. -->
    <div class="player-caption">
      <Transition name="player-caption">
        <div :key="current" class="player-caption-text">
          <div class="player-caption-title">{{ chapters[current]?.title }}</div>
          <div class="player-caption-detail">{{ chapters[current]?.detail }}</div>
        </div>
      </Transition>
      <div v-for="chapter in chapters" :key="chapter.label" class="player-caption-text player-caption-size" aria-hidden="true">
        <div class="player-caption-title">{{ chapter.title }}</div>
        <div class="player-caption-detail">{{ chapter.detail }}</div>
      </div>
    </div>
  </figure>
  <figure v-else class="illustration" :class="{ full }">
    <div ref="host" class="illustration-stage" role="img" :aria-label="FIGURES[name]" :style="vars" />
    <button class="illustration-replay" type="button" @click="run++">Replay</button>
  </figure>
</template>
