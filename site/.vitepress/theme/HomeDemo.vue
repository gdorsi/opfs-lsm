<script setup lang="ts">
import { useData, withBase } from "vitepress";
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import DemoToast from "./DemoToast.vue";
import type { Visit } from "./demo.ts";

/**
 * LinearLite in a browser frame. The app is the static build of `examples/linearlite-docstore`, served next to the site.
 * It measures itself and posts each timing here (`examples/linearlite-docstore/src/protocol.ts` lists the messages). This
 * component keeps the visit those messages tell, and a toast over the frame says it.
 *
 * On a touch screen or a narrow one the frame is a preview the page scrolls past: the app inside it takes no input,
 * so a swipe over it scrolls the page, not the app's list. Tapping it opens the app full screen.
 */
const SOURCE = "linearlite-demo";

const { frontmatter } = useData();
const countLabel = computed(() => String(frontmatter.value.demo.count));
const count = computed(() => Number(countLabel.value.replace(/\D/g, "")));
/** Unset until this page is idle, so the app does not share the main thread with the page's own start. */
const src = ref<string>();

const frame = ref<HTMLIFrameElement>();
const visit = ref<Visit>({ kind: "waiting" });
/** A filter's time, shown over the visit's message for a few seconds. */
const filter = ref<{ label: string; ms: number }>();
let filterTimer: ReturnType<typeof setTimeout> | undefined;
/** Whether this page wrote the issues. It survives a reload of the frame, so the next open is a reopen. */
let wrote = false;
/** Whether the next open that finds no issues writes them: true at the page's first open, and after Start over. */
let writeOnEmpty = true;

/** The visits that have a time to compare a filter's with. */
const TIMED: Visit["kind"][] = ["written", "reopened", "returning"];

const post = (message: Record<string, unknown>) =>
  frame.value?.contentWindow?.postMessage({ source: SOURCE, ...message }, location.origin);

/** Moves to the next visit. A filter's time belongs to the visit it was measured in, so it goes too. */
function enter(next: Visit) {
  visit.value = next;
  clearTimeout(filterTimer);
  filter.value = undefined;
}

function onMessage(e: MessageEvent) {
  if (e.source !== frame.value?.contentWindow || e.data?.source !== SOURCE) return;
  const m = e.data;
  switch (m.type) {
    case "opened":
      // With issues stored, the app is still reading its first rows: the visit stays loading until `first-rows`.
      if (m.issues > 0) break;
      if (writeOnEmpty) {
        writeOnEmpty = false;
        post({ type: "generate", count: count.value });
        enter({ kind: "writing", written: 0, total: count.value });
      } else enter({ kind: "empty" });
      break;
    case "progress":
      enter({ kind: "writing", written: m.phase === "writing" ? m.written : 0, total: m.total });
      break;
    case "generated":
      wrote = true;
      enter({ kind: "written", count: m.count, writeMs: m.writeMs });
      break;
    case "first-rows":
      enter(wrote ? { kind: "reopened", ms: m.ms } : { kind: "returning", ms: m.ms });
      break;
    case "filter":
      if (!TIMED.includes(visit.value.kind)) break;
      filter.value = { label: m.label, ms: m.rowsMs };
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => (filter.value = undefined), 4000);
      break;
    case "deleted":
      wrote = false;
      reload();
      break;
    case "failed":
      enter({ kind: "failed", message: m.message });
      break;
  }
}

function reload() {
  enter({ kind: "loading" });
  frame.value?.contentWindow?.location.reload();
}

/** A first visit again: the app deletes its issues and reloads, and the page writes them anew. */
function startOver() {
  writeOnEmpty = true;
  enter({ kind: "loading" });
  post({ type: "delete" });
}

/**
 * Calls `then` once the page has loaded and the browser reports a whole idle period, or after three seconds. The
 * frame shares this page's main thread, so an app loaded sooner would be timed while the page mounts its figures.
 */
function whenIdle(then: () => void) {
  const deadline = performance.now() + 3000;
  const wait = () => {
    if (typeof requestIdleCallback !== "function") return void setTimeout(then, 300);
    requestIdleCallback((idle) => (idle.timeRemaining() >= 40 || performance.now() > deadline ? then() : wait()), { timeout: 1000 });
  };
  if (document.readyState === "complete") wait();
  else addEventListener("load", wait, { once: true });
}

/*
 * Preview and full screen. Moving the iframe in the document would reload the app, so full screen restyles its box
 * to cover the viewport instead. The box it leaves keeps its height, so the page under it doesn't move. Opening grows
 * from the preview's rectangle (a clip-path), and closing shrinks back into it.
 */
const compact = ref(false);
const expanded = ref(false);
const view = ref<HTMLDivElement>();
const screen = ref<HTMLDivElement>();
const openButton = ref<HTMLButtonElement>();
const closeButton = ref<HTMLButtonElement>();
const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const FULL = "inset(0px 0px 0px 0px round 0px)";
const insetOf = (r: DOMRect) =>
  `inset(${r.top}px ${innerWidth - r.right}px ${innerHeight - r.bottom}px ${r.left}px round 14px)`;
let reduced = false;
let morph: Animation | undefined;

const lock = (on: boolean) => {
  document.documentElement.style.overflow = on ? "hidden" : "";
};

async function open() {
  if (expanded.value || !view.value) return;
  const from = insetOf(view.value.getBoundingClientRect());
  expanded.value = true;
  lock(true);
  await nextTick();
  closeButton.value?.focus({ preventScroll: true });
  if (reduced || !screen.value) return;
  morph?.cancel();
  morph = screen.value.animate([{ clipPath: from }, { clipPath: FULL }], { duration: 380, easing: EASE });
}

async function close(animate = true) {
  if (!expanded.value) return;
  if (animate && !reduced && screen.value && view.value) {
    morph?.cancel();
    morph = screen.value.animate([{ clipPath: FULL }, { clipPath: insetOf(view.value.getBoundingClientRect()) }], {
      duration: 280,
      easing: EASE,
      fill: "forwards",
    });
    await morph.finished.catch(() => {});
  }
  expanded.value = false;
  lock(false);
  await nextTick();
  morph?.cancel();
  openButton.value?.focus({ preventScroll: true });
}

const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape" && expanded.value) close();
};

let media: MediaQueryList | undefined;
const onMedia = () => {
  compact.value = !!media?.matches;
  if (!compact.value) close(false);
};

let mounted = false;
onMounted(() => {
  mounted = true;
  reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  media = matchMedia("(max-width: 639px), (pointer: coarse)");
  onMedia();
  media.addEventListener("change", onMedia);
  addEventListener("message", onMessage);
  addEventListener("keydown", onKey);
  whenIdle(() => {
    if (!mounted) return;
    enter({ kind: "loading" });
    src.value = withBase(`/demo/index.html?count=${count.value}&theme=dark`);
  });
});
onBeforeUnmount(() => {
  mounted = false;
  media?.removeEventListener("change", onMedia);
  removeEventListener("message", onMessage);
  removeEventListener("keydown", onKey);
  clearTimeout(filterTimer);
  if (expanded.value) lock(false);
});

const starting = computed(() => visit.value.kind === "waiting" || visit.value.kind === "loading");
</script>

<template>
  <div class="demo" :data-compact="compact ? '' : undefined">
    <div class="demo-bar">
      <span class="demo-dots" aria-hidden="true"><i /><i /><i /></span>
      <span class="demo-title">Example app</span>
    </div>

    <div ref="view" class="demo-view">
      <div
        ref="screen"
        class="demo-screen"
        :data-expanded="expanded ? '' : undefined"
        :role="expanded ? 'dialog' : undefined"
        :aria-modal="expanded ? 'true' : undefined"
        :aria-label="expanded ? 'LinearLite, full screen' : undefined"
      >
        <div v-show="expanded" class="demo-screen-bar">
          <button ref="closeButton" type="button" class="demo-screen-button" @click="close()">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
            Close
          </button>
          <span class="demo-screen-title">Example app</span>
        </div>

        <iframe
          ref="frame"
          class="demo-frame"
          :src="src"
          :inert="compact && !expanded ? '' : undefined"
          title="LinearLite, an issue tracker running on opfs-lsm with no server"
        />

        <!-- The preview's cover: a swipe on it scrolls the page, a tap opens the app. -->
        <button
          v-if="compact && !expanded"
          ref="openButton"
          type="button"
          class="demo-open"
          :disabled="starting"
          :aria-label="starting ? 'Starting the app' : 'Open the app full screen'"
          @click="open"
        >
          <span class="demo-open-pill">
            <template v-if="starting">Starting the app</template>
            <template v-else>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" /></svg>
              Open the app
            </template>
          </span>
        </button>

        <DemoToast :visit="visit" :filter="filter" :count="countLabel" @reload="reload" @start-over="startOver" />

        <div v-if="!compact && starting" class="demo-status" role="status">Starting the app</div>
      </div>
    </div>

    <p v-if="visit.kind === 'failed'" class="demo-failed" role="alert">The demo could not run in this browser: {{ visit.message }}</p>
  </div>
</template>
