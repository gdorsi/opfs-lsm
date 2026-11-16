<script setup lang="ts">
import { withBase } from "vitepress";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Illustration from "./Illustration.vue";

/**
 * The home page's use cases: a tab per case. The figure draws that case's stack (the `fits` still), and the card
 * beside it shows the code that wires the case up; a case with two adapters has a tab for each over its code. The
 * code is the page's own Markdown, one slot per adapter named by its `slot`, so Shiki renders it like every other
 * block on the page.
 */
type Adapter = {
  name: string;
  /** The library's object that holds the data, as the figure names it. */
  library: string;
  package: string;
  slot: string;
  guide: string;
  example?: { name: string; link: string };
};
type Case = { case: string; detail: string; name: string; stores: string; adapters: Adapter[] };

const props = defineProps<{ cases: Case[] }>();

const active = ref(0);
const adapter = ref(0);
/** Set by the first pick: the words that change come in from below, but not on load. */
const picked = ref(false);
/** Set once the raised pill sits on the first tab, so it slides from then on and never from the corner. */
const ready = ref(false);
const list = ref<HTMLElement>();
const pill = ref<HTMLElement>();
const tabs: HTMLButtonElement[] = [];

const current = computed(() => props.cases[active.value]!);
const shown = computed(() => current.value.adapters[adapter.value] ?? current.value.adapters[0]!);
/** The figure draws the adapter on show: picking Automerge over Yjs redraws it too. */
const figure = computed(() => ({
  case: { library: shown.value.library, stores: current.value.stores, package: shown.value.package },
}));
const label = computed(
  () =>
    `Your server syncs with ${shown.value.library}, which stores ${current.value.stores} in opfs-lsm through ${shown.value.package}. opfs-lsm writes to OPFS, the browser's file storage for your site.`,
);

function pick(i: number) {
  active.value = i;
  adapter.value = 0;
  picked.value = true;
}

function pickAdapter(i: number) {
  adapter.value = i;
  picked.value = true;
}

function place() {
  const el = tabs[active.value];
  const p = pill.value;
  if (!el || !p) return;
  p.style.width = `${el.offsetWidth}px`;
  p.style.height = `${el.offsetHeight}px`;
  p.style.transform = `translate(${el.offsetLeft}px, ${el.offsetTop}px)`;
}

/** Arrows move between tabs and pick as they go, as a tablist does. */
function onKey(e: KeyboardEvent) {
  const n = props.cases.length;
  const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[e.key];
  const next =
    e.key === "Home" ? 0 : e.key === "End" ? n - 1 : step === undefined ? undefined : (active.value + step + n) % n;
  if (next === undefined) return;
  e.preventDefault();
  pick(next);
  tabs[next]?.focus();
}

let observer: ResizeObserver | undefined;
watch(active, () => nextTick(place));
onMounted(() => {
  place();
  observer = new ResizeObserver(place);
  if (list.value) observer.observe(list.value);
  requestAnimationFrame(() => requestAnimationFrame(() => (ready.value = true)));
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div class="uc">
    <div ref="list" class="uc-tabs" role="tablist" aria-label="Use cases" :data-ready="ready || undefined" @keydown="onKey">
      <span ref="pill" class="uc-pill" aria-hidden="true" />
      <button
        v-for="(c, i) in cases"
        :id="`uc-tab-${i}`"
        :key="c.case"
        :ref="(el) => (tabs[i] = el as HTMLButtonElement)"
        class="uc-tab"
        role="tab"
        type="button"
        aria-controls="uc-panel"
        :aria-selected="i === active"
        :tabindex="i === active ? 0 : -1"
        @click="pick(i)"
      >
        <span class="uc-case">{{ c.case }}</span>
        <span class="uc-name">{{ c.name }}</span>
      </button>
    </div>

    <div id="uc-panel" class="uc-panel" role="tabpanel" :aria-labelledby="`uc-tab-${active}`">
      <Illustration name="fits" :data="figure" :label="label" />

      <div class="uc-body">
        <p :key="active" class="uc-detail" :class="{ 'uc-in': picked }">{{ current.detail }}</p>

        <div class="uc-code">
          <div class="uc-code-bar">
            <template v-if="current.adapters.length > 1">
              <button
                v-for="(a, i) in current.adapters"
                :key="a.slot"
                class="uc-code-tab"
                type="button"
                :aria-pressed="i === adapter"
                @click="pickAdapter(i)"
              >
                {{ a.name }}
              </button>
            </template>
            <span v-else class="uc-code-title">{{ shown.name }}</span>
          </div>
          <div :key="shown.slot" class="uc-snippet" :class="{ 'uc-in': picked }">
            <slot :name="shown.slot" />
          </div>
        </div>

        <p class="uc-links">
          <a class="uc-guide" :href="withBase(shown.guide)">
            Read the {{ shown.name }} guide
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M3 8h9M8.5 4.5L12 8l-3.5 3.5" />
            </svg>
          </a>
          <a v-if="shown.example" class="uc-example" :href="shown.example.link">Example: {{ shown.example.name }}</a>
        </p>
      </div>
    </div>
  </div>
</template>
