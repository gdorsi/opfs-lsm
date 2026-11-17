<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ms, n, type Visit } from "./demo.ts";

/**
 * The visit's message, over the frame: the write as it runs, then what it took, then what a reload or a return visit
 * took. A filter's time shows over it for a few seconds. Closed, it shrinks to a pill with the latest time, and a new kind
 * of visit restores it.
 */
const props = defineProps<{ visit: Visit; filter?: { label: string; ms: number }; count: string }>();
defineEmits<{ reload: []; startOver: [] }>();

const hidden = ref(false);
watch(
  () => props.visit.kind,
  () => (hidden.value = false),
);

const percent = computed(() => {
  const { visit } = props;
  return visit.kind === "writing" && visit.total > 0 ? Math.round((100 * visit.written) / visit.total) : 0;
});

const latest = computed(() => {
  const { visit, filter } = props;
  if (filter) return filter.ms;
  if (visit.kind === "written") return visit.writeMs;
  if (visit.kind === "reopened" || visit.kind === "returning") return visit.ms;
  return undefined;
});
</script>

<template>
  <div class="demo-toast-region" aria-live="polite">
    <Transition name="demo-toast" mode="out-in">
      <button
        v-if="hidden && latest !== undefined"
        key="pill"
        type="button"
        class="demo-toast demo-toast-pill"
        :aria-label="`${ms(latest)}. Show the message`"
        @click="hidden = false"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2" /><path d="M9 2h6" /></svg>
        {{ ms(latest) }}
      </button>

      <div v-else-if="filter" key="filter" class="demo-toast">
        <p><b>{{ ms(filter.ms) }}</b> to filter the list · {{ filter.label }}</p>
      </div>

      <div v-else-if="visit.kind === 'writing'" key="writing" class="demo-toast">
        <p>Storing {{ count }} random issues in your browser · <b aria-hidden="true">{{ percent }}%</b></p>
      </div>

      <div v-else-if="visit.kind === 'written'" key="written" class="demo-toast">
        <p>Stored {{ n(visit.count) }} random issues in <b>{{ ms(visit.writeMs) }}</b>. Reload to see how fast they open on your device.</p>
        <div class="demo-toast-actions">
          <button type="button" class="demo-toast-button demo-toast-primary" @click="$emit('reload')">Reload</button>
          <button type="button" class="demo-toast-close" aria-label="Hide the message" @click="hidden = true">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12" /><path d="M18 6L6 18" /></svg>
          </button>
        </div>
      </div>

      <div v-else-if="visit.kind === 'reopened'" key="reopened" class="demo-toast">
        <p>Opened them in <b>{{ ms(visit.ms) }}</b>, as on a return visit.</p>
        <div class="demo-toast-actions">
          <button type="button" class="demo-toast-button" @click="$emit('reload')">Reload again</button>
          <button type="button" class="demo-toast-button demo-toast-quiet" @click="$emit('startOver')">Start over</button>
          <button type="button" class="demo-toast-close" aria-label="Hide the message" @click="hidden = true">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12" /><path d="M18 6L6 18" /></svg>
          </button>
        </div>
      </div>

      <div v-else-if="visit.kind === 'returning'" key="returning" class="demo-toast">
        <p>Welcome back. Your browser kept the issues, and opened them in <b>{{ ms(visit.ms) }}</b>.</p>
        <div class="demo-toast-actions">
          <button type="button" class="demo-toast-button" @click="$emit('reload')">Reload</button>
          <button type="button" class="demo-toast-button demo-toast-quiet" @click="$emit('startOver')">Start as a new visitor</button>
          <button type="button" class="demo-toast-close" aria-label="Hide the message" @click="hidden = true">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12" /><path d="M18 6L6 18" /></svg>
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>
