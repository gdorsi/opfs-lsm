/** A clock for a scene told in chapters, which the page's player pauses. While paused its time stands still. */
export type Playhead = {
  /** Milliseconds played, not counting time spent paused. */
  now(): number;
  setPaused(paused: boolean): void;
};

export function createPlayhead(): Playhead {
  let paused = false;
  let at = 0;
  let last = performance.now();
  const now = () => {
    const t = performance.now();
    if (!paused) at += t - last;
    last = t;
    return at;
  };
  return {
    now,
    setPaused(next) {
      now();
      paused = next;
    },
  };
}
