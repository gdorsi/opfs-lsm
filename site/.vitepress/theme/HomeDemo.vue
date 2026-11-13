<script setup lang="ts">
import { useData, withBase } from "vitepress";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

/**
 * LinearLite in a frame, with the controls and the timings around it. The app is the static build of
 * `examples/linearlite/demo`, served next to the site. It measures itself and posts each timing here
 * (`examples/linearlite/demo/protocol.ts` lists the messages); this component only shows them.
 */
const SOURCE = "linearlite-demo";
const DB = "opfs-lsm-home";

type Host = "restarted" | "alive" | "unknown";
type Stored = { opfsBytes: number; files: number; idbBytes?: number };
type Progress = { phase: "generating" | "writing"; written: number; total: number };

const { frontmatter } = useData();
const countLabel = computed(() => String(frontmatter.value.demo.count));
const count = computed(() => Number(countLabel.value.replace(/\D/g, "")));
const src = computed(() => withBase(`/demo/index.html?db=${DB}&count=${count.value}#/`));

const frame = ref<HTMLIFrameElement>();
const state = ref<"loading" | "empty" | "generating" | "ready" | "failed">("loading");
const progress = ref<Progress>();
const written = ref<{ count: number; generateMs: number; writeMs: number }>();
const opened = ref<{ ms: number; host: Host; reload: boolean }>();
const filtered = ref<{ label: string; rowsMs: number; total?: number; totalMs?: number }>();
const stored = ref<Stored>();
const failure = ref("");
let reloading = false;

const post = (message: Record<string, unknown>) => frame.value?.contentWindow?.postMessage({ source: SOURCE, ...message }, location.origin);

function onMessage(e: MessageEvent) {
  if (e.source !== frame.value?.contentWindow || e.data?.source !== SOURCE) return;
  const m = e.data;
  if (m.type === "opened") state.value = m.issues > 0 ? "ready" : "empty";
  else if (m.type === "progress") {
    state.value = "generating";
    progress.value = m;
  } else if (m.type === "generated") {
    state.value = "ready";
    written.value = m;
  } else if (m.type === "first-rows") {
    opened.value = { ms: m.ms, host: m.host, reload: reloading };
    reloading = false;
  } else if (m.type === "filter") filtered.value = m;
  else if (m.type === "stored") stored.value = m.stored;
  else if (m.type === "deleted") reload(false);
  else if (m.type === "failed") {
    state.value = "failed";
    failure.value = m.message;
  }
}

function reload(timed = true) {
  reloading = timed;
  state.value = "loading";
  opened.value = undefined;
  filtered.value = undefined;
  if (!timed) written.value = undefined;
  frame.value?.contentWindow?.location.reload();
}

onMounted(() => addEventListener("message", onMessage));
onBeforeUnmount(() => removeEventListener("message", onMessage));

const ms = (n: number) => (n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)} s`);
const n = (x: number) => Math.round(x).toLocaleString("en-US");
const mb = (bytes: number) => (bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} kB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** What restarted with the page. `examples/linearlite/DESIGN.md` says what each one means for the timing. */
const HOSTS: Record<Host, string> = {
  restarted: "cold: page and SharedWorker restarted",
  alive: "page only: SharedWorker still running",
  unknown: "page restarted",
};
</script>

<template>
  <div class="demo" :data-state="state">
    <div class="demo-bar">
      <button class="demo-btn primary" type="button" :disabled="state !== 'empty'" @click="post({ type: 'generate', count })">
        Generate {{ countLabel }} issues
      </button>
      <button class="demo-btn" type="button" :disabled="state !== 'ready'" @click="reload()">Reload the app</button>
      <button class="demo-btn" type="button" :disabled="state !== 'ready'" @click="post({ type: 'delete' })">Delete the data</button>
      <span class="demo-stored" role="status">
        <template v-if="stored">
          {{ mb(stored.opfsBytes) }} in OPFS<template v-if="stored.idbBytes !== undefined">, {{ mb(stored.idbBytes) }} in IndexedDB</template>
        </template>
      </span>
    </div>

    <iframe ref="frame" class="demo-frame" :src="src" title="LinearLite, an issue tracker, running on kv with no server" loading="lazy" />

    <dl class="demo-timings" aria-live="polite">
      <div>
        <dt>Write {{ countLabel }} issues</dt>
        <dd v-if="state === 'generating' && progress">
          <b>{{ progress.phase === "generating" ? "Generating" : "Writing" }}</b>
          <span>{{ n(progress.written) }} of {{ n(progress.total) }}</span>
        </dd>
        <dd v-else-if="written">
          <b>{{ ms(written.writeMs) }}</b>
          <span>{{ n(written.count / (written.writeMs / 1000)) }} issues/s</span>
        </dd>
        <dd v-else><b class="demo-none">–</b></dd>
      </div>
      <div>
        <dt>Filter to rows on screen</dt>
        <dd v-if="filtered">
          <b>{{ ms(filtered.rowsMs) }}</b>
          <span>
            {{ filtered.label }}<template v-if="filtered.total !== undefined">, {{ n(filtered.total) }} matches</template>
          </span>
        </dd>
        <dd v-else><b class="demo-none">–</b></dd>
      </div>
      <div>
        <dt>{{ opened && !opened.reload ? "Open to first rows" : "Reload to first rows" }}</dt>
        <dd v-if="opened">
          <b>{{ ms(opened.ms) }}</b>
          <span>{{ HOSTS[opened.host] }}</span>
        </dd>
        <dd v-else><b class="demo-none">–</b></dd>
      </div>
    </dl>
    <p v-if="state === 'failed'" class="demo-failed" role="alert">The demo could not run in this browser: {{ failure }}</p>
  </div>
</template>
