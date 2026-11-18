<script setup lang="ts">
import { withBase } from "vitepress";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Chart } from "./bench.ts";

/**
 * The home page's adapters: a tab per library. The card shows what the adapter is for, one measured speedup, and
 * the change to the app's code as a diff against the library's IndexedDB storage. The speedup is a row of the
 * page's benchmarks, found by its `measure`, so the two never disagree. The code is the page's own
 * Markdown, one slot per adapter named by its `slot`, so Shiki renders the diff like every other block on the page.
 */
type Adapter = {
  name: string;
  detail: string;
  /** The library's own IndexedDB storage, which the diff removes. None for your own adapter on kv. */
  replaces?: string;
  /** The `measure` of a row in the page's benchmarks. */
  bench: string;
  slot: string;
  guide: string;
  example?: { name: string; link: string };
};

const props = defineProps<{ adapters: Adapter[]; charts: Chart[] }>();

const rows = new Map(props.charts.flatMap((c) => c.groups.flatMap((g) => g.rows)).map((r) => [r.measure, r]));
/** "Yjs: cold load of 500 notes" reads "faster cold load of 500 notes than", then the storage it replaces. */
const numbers = props.adapters.map((a) => {
  const row = rows.get(a.bench);
  if (!row) throw new Error(`No benchmark row "${a.bench}" for the ${a.name} adapter`);
  const measure = a.bench.replace(/^[^:]+: /, "").replace(/^./, (c) => c.toLowerCase());
  return { ratio: row.ratio, text: `faster ${measure} than`, than: a.replaces ?? "IndexedDB" };
});

const active = ref(0);
/** Set by the first pick: the words that change come in from below, but not on load. */
const picked = ref(false);
/** Set once the raised pill sits on the first tab, so it slides from then on and never from the corner. */
const ready = ref(false);
const list = ref<HTMLElement>();
const pill = ref<HTMLElement>();
const tabs: HTMLButtonElement[] = [];

const shown = computed(() => props.adapters[active.value]!);
const number = computed(() => numbers[active.value]!);

function pick(i: number) {
  active.value = i;
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
  const n = props.adapters.length;
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
  <div class="ad">
    <div ref="list" class="ad-tabs" role="tablist" aria-label="Adapters" :data-ready="ready || undefined" @keydown="onKey">
      <span ref="pill" class="ad-pill" aria-hidden="true" />
      <button
        v-for="(a, i) in adapters"
        :id="`ad-tab-${i}`"
        :key="a.slot"
        :ref="(el) => (tabs[i] = el as HTMLButtonElement)"
        class="ad-tab"
        role="tab"
        type="button"
        aria-controls="ad-panel"
        :aria-selected="i === active"
        :tabindex="i === active ? 0 : -1"
        @click="pick(i)"
      >
        {{ a.name }}
      </button>
    </div>

    <div id="ad-panel" class="ad-panel" role="tabpanel" :aria-labelledby="`ad-tab-${active}`">
      <div :key="active" class="ad-copy" :class="{ 'ad-in': picked }">
        <p class="ad-detail">{{ shown.detail }}</p>
        <p class="ad-number">
          <strong>{{ number.ratio }}</strong>
          <span>{{ number.text }} <span class="ad-than">{{ number.than }}</span></span>
        </p>
        <p class="ad-links">
          <a class="ad-guide" :href="withBase(shown.guide)">
            Read the {{ shown.replaces ? shown.name : "kv" }} guide
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M3 8h9M8.5 4.5L12 8l-3.5 3.5" />
            </svg>
          </a>
          <a v-if="shown.example" class="ad-example" :href="shown.example.link">Example: {{ shown.example.name }}</a>
        </p>
      </div>

      <div class="ad-code">
        <div class="ad-code-bar">{{ shown.replaces ? `Replaces ${shown.replaces}` : "Your adapter, on kv" }}</div>
        <div :key="shown.slot" class="ad-snippet" :class="{ 'ad-in': picked }">
          <slot :name="shown.slot" />
        </div>
      </div>
    </div>
  </div>
</template>
