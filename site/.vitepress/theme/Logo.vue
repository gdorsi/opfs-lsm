<script setup lang="ts">
/**
 * The mark: the sixteen bits of "ol", the initials of opfs-lsm, in ASCII (`o` is 0x6f and `l` is 0x6c). A row holds
 * four bits. A set bit is lit and a clear bit is dim, and the set bits light one after the other when the mark renders.
 */
let lit = 0;
const bits = [..."0110111101101100"].map((bit, i) => ({
  x: (i % 4) * 8,
  y: (i >> 2) * 8,
  order: bit === "1" ? lit++ : undefined,
}));
</script>

<template>
  <svg class="logo-mark" viewBox="0 0 30 30" aria-hidden="true">
    <rect
      v-for="bit in bits"
      :key="`${bit.x} ${bit.y}`"
      :class="bit.order === undefined ? 'logo-bit-clear' : 'logo-bit-set'"
      :style="bit.order === undefined ? undefined : { '--order': bit.order }"
      :x="bit.x"
      :y="bit.y"
      width="6"
      height="6"
      rx="1"
    />
  </svg>
</template>
