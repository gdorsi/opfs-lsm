<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Playhead } from "../../stageshow/playhead.ts";
import type { Chapter } from "./figures.ts";

/**
 * A player's controls: pause, the chapters as colored segments to jump between, a bar at the play position with the
 * chapter's name in a flag under it, and the time played. Hovering a segment previews its name in a second flag. The fills,
 * the bar, the flags' positions and the time are written from the playhead outside Vue, as transforms, from geometry
 * measured on resize, so a frame never forces a layout. `clock` is the chapter playing and when it started.
 * `still`: the scene is a still under reduced motion, so the bar only jumps between chapters.
 */
const props = defineProps<{
  chapters: readonly Chapter[];
  playhead: Playhead;
  clock: { chapter: number; startedAt: number };
  current: number;
  paused: boolean;
  still: boolean;
}>();
const emit = defineEmits<{ toggle: []; jump: [chapter: number] }>();

const root = ref<HTMLElement>();
const track = ref<HTMLElement>();
const head = ref<HTMLElement>();
const flag = ref<HTMLElement>();
const hoverFlag = ref<HTMLElement>();
const time = ref<HTMLElement>();
const segments: (HTMLElement | null)[] = [];
const fills: (HTMLElement | null)[] = [];
const hover = ref<number | null>(null);
let hoverX: number | null = null;
let geo = { segs: [] as { left: number; width: number }[], track: 0, flag: 0, hover: 0 };

const clockTime = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const total = computed(() => props.chapters.reduce((sum, c) => sum + c.ms, 0));
const color = (i: number) => `var(--player-${i % 7})`;

function draw() {
  const ms = props.chapters.map((c) => c.ms);
  const c = props.clock.chapter;
  const into = props.still ? ms[c]! : Math.min(ms[c]!, Math.max(0, props.playhead.now() - props.clock.startedAt));
  const p = into / ms[c]!;
  const seg = geo.segs[c];
  const x = seg ? seg.left + p * seg.width : 0;
  const clamp = (at: number, w: number) => Math.min(Math.max(0, at - w / 2), Math.max(0, geo.track - w));
  fills.forEach((el, i) => {
    if (el) el.style.transform = `scaleX(${i < c ? 1 : i === c ? p : 0})`;
  });
  if (head.value) head.value.style.transform = `translateX(${x}px)`;
  if (flag.value) flag.value.style.transform = `translateX(${clamp(x, geo.flag)}px)`;
  if (hoverFlag.value && hoverX !== null) hoverFlag.value.style.transform = `translateX(${clamp(hoverX, geo.hover)}px)`;
  const text = `${clockTime(ms.slice(0, c).reduce((sum, m) => sum + m, 0) + into)} / ${clockTime(total.value)}`;
  if (time.value && time.value.textContent !== text) time.value.textContent = text;
}

function measure() {
  geo = {
    segs: segments.map((el) => ({ left: el?.offsetLeft ?? 0, width: el?.offsetWidth ?? 0 })),
    track: track.value?.offsetWidth ?? 0,
    flag: flag.value?.offsetWidth ?? 0,
    hover: hoverFlag.value?.offsetWidth ?? 0,
  };
  draw();
}

const onMove = (e: PointerEvent) => {
  const el = e.currentTarget as HTMLElement;
  const x = e.clientX - el.getBoundingClientRect().left;
  hoverX = x;
  const i = geo.segs.findIndex((s) => x < s.left + s.width);
  hover.value = i === -1 ? props.chapters.length - 1 : i;
  // The frame loop may be stopped (paused, or between frames): place the preview now.
  draw();
};
const onLeave = () => {
  hoverX = null;
  hover.value = null;
};

// Frames run only while the bar is on screen and the scene plays. Paused, jumped or still, one draw brings it up to date.
const visible = ref(false);
let frame = 0;
let resize: ResizeObserver | undefined;
let seen: IntersectionObserver | undefined;
const loop = () => {
  cancelAnimationFrame(frame);
  draw();
  if (!visible.value || props.paused || props.still) return;
  const tick = () => {
    draw();
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
};

onMounted(() => {
  measure();
  resize = new ResizeObserver(measure);
  for (const el of [track.value, flag.value, hoverFlag.value]) if (el) resize.observe(el);
  // One callback can carry several entries, oldest first (off screen at load, then on screen after a jump to the
  // anchor): the last is the one that holds.
  seen = new IntersectionObserver((entries) => (visible.value = !!entries.at(-1)?.isIntersecting));
  if (root.value) seen.observe(root.value);
});
watch(() => [visible.value, props.paused, props.still, props.current], loop);
onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  resize?.disconnect();
  seen?.disconnect();
});
</script>

<template>
  <div ref="root" class="player-bar">
    <button v-if="!still" type="button" class="player-toggle" :aria-label="paused ? 'Play the animation' : 'Pause the animation'" @click="emit('toggle')">
      <svg v-if="paused" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L7.5 3.64A1 1 0 0 0 6 4.5z" /></svg>
      <svg v-else viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="5" height="18" rx="1" /><rect x="14" y="3" width="5" height="18" rx="1" /></svg>
    </button>
    <div ref="track" class="player-track" @pointermove="onMove" @pointerleave="onLeave">
      <button
        v-for="(chapter, i) in chapters"
        :key="chapter.label"
        :ref="(el) => (segments[i] = el as HTMLElement | null)"
        type="button"
        class="player-segment"
        :style="{ flexGrow: chapter.ms }"
        :aria-label="`${still ? 'Show' : 'Play'}: ${chapter.label}`"
        :aria-current="i === current ? 'step' : undefined"
        @click="emit('jump', i)"
      >
        <span class="player-segment-track">
          <span :ref="(el) => (fills[i] = el as HTMLElement | null)" class="player-segment-fill" :style="{ background: color(i) }" />
        </span>
      </button>
      <span ref="head" class="player-head" :style="{ background: color(current) }" />
      <span ref="flag" class="player-flag" :class="{ 'player-flag-hidden': hover !== null && hover !== current }" :style="{ background: color(current) }">
        {{ chapters[current]?.label }}
      </span>
      <!-- The preview: which chapter a click on the segment under the pointer plays. -->
      <span
        ref="hoverFlag"
        class="player-flag"
        :class="{ 'player-flag-hidden': hover === null || hover === current }"
        :style="{ background: hover === null ? undefined : color(hover) }"
        aria-hidden="true"
      >
        {{ hover === null ? "" : chapters[hover]?.label }}
      </span>
    </div>
    <span v-if="!still" ref="time" class="player-time">0:00 / {{ clockTime(total) }}</span>
  </div>
</template>
