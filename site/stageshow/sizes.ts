/**
 * The design size of each illustration, wide and compact, in CSS pixels. The page reserves a box of this shape
 * before the illustration loads. A stage switches to its compact design in a column narrower than `COMPACT_BELOW`.
 */
export const COMPACT_BELOW = 600;

/** The same for an illustration as wide as the page. `Illustration.vue` switches its box at the matching viewport. */
export const FULL_COMPACT_BELOW = 720;

export const SIZES = {
  adapters: { wide: [1152, 372], compact: [358, 962] },
  bundle: { wide: [620, 400], compact: [358, 492] },
  stack: { wide: [620, 400], compact: [358, 470] },
  sync: { wide: [600, 380], compact: [358, 464] },
} as const satisfies Record<string, { wide: readonly [number, number]; compact: readonly [number, number] }>;

export type SceneName = keyof typeof SIZES;
