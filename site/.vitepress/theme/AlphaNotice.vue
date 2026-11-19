<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

/**
 * The "alpha" tag, with the page's status notice under it. Here the notice is what the tag's dot says: its "under
 * construction" note stays hidden, and only names the button. The notice opens once the pointer has rested on the tag
 * and closes once it has left the tag and the notice. A click pins it open, which is how a touch screen or the
 * keyboard opens it. Escape, or a press outside, closes it.
 */
defineProps<{ notice: { title: string; body: string; link: string } }>();

const root = ref<HTMLElement>();
const open = ref(false);
const pinned = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

function hover(enter: boolean, e: PointerEvent) {
  if (e.pointerType === "touch" || pinned.value) return;
  clearTimeout(timer);
  timer = setTimeout(() => (open.value = enter), enter ? 120 : 150);
}

function toggle() {
  clearTimeout(timer);
  pinned.value = !pinned.value;
  open.value = pinned.value;
}

function close() {
  clearTimeout(timer);
  open.value = pinned.value = false;
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") close();
}

function onPress(e: PointerEvent) {
  if (!root.value?.contains(e.target as Node)) close();
}

onMounted(() => {
  addEventListener("keydown", onKey);
  addEventListener("pointerdown", onPress);
});
onBeforeUnmount(() => {
  clearTimeout(timer);
  removeEventListener("keydown", onKey);
  removeEventListener("pointerdown", onPress);
});
</script>

<template>
  <span ref="root" class="alpha-notice" @pointerenter="hover(true, $event)" @pointerleave="hover(false, $event)">
    <button type="button" class="alpha-tag" :aria-expanded="open" aria-controls="alpha-notice" @click="toggle">
      <span class="alpha-dot" aria-hidden="true"></span>alpha <span class="alpha-note">under construction</span>
    </button>
    <Transition name="alpha-notice">
      <div v-show="open" id="alpha-notice" class="alpha-notice-card">
        <strong>{{ notice.title }}</strong>
        <p>{{ notice.body }}</p>
        <a :href="notice.link" target="_blank" rel="noreferrer">Share feedback <span aria-hidden="true">↗</span></a>
      </div>
    </Transition>
  </span>
</template>
