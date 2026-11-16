/**
 * The design size of each illustration, wide and compact, in CSS pixels. The page reserves a box of this shape
 * before the illustration loads. A stage switches to its compact design in a column narrower than `COMPACT_BELOW`.
 */
export const COMPACT_BELOW = 600;

/** The same for an illustration as wide as the page. `Illustration.vue` switches its box at the matching viewport. */
export const FULL_COMPACT_BELOW = 720;

export const SIZES = {
  apps: { wide: [1152, 452], compact: [358, 1000] },
  features: { wide: [600, 416], compact: [358, 608] },
  fits: { wide: [300, 340], compact: [300, 340] },
  stack: { wide: [620, 400], compact: [358, 470] },
} as const satisfies Record<string, { wide: readonly [number, number]; compact: readonly [number, number] }>;

export type SceneName = keyof typeof SIZES;

/** Illustrations drawn as one still frame. They don't play, so the page shows no Replay button under them. */
export const STILLS: ReadonlySet<SceneName> = new Set(["fits"]);
