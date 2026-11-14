import type { Env } from "./types.ts";

/**
 * The real clock, timers and ids. The only model file that may touch them (see .oxlintrc.json): everything else
 * receives an Env, so tests and bench replay exactly.
 */
export const systemEnv: Env = {
  id() {
    let id = "";
    while (id.length < 12) id += Math.random().toString(36).slice(2);
    return id.slice(0, 12);
  },
  now: () => Date.now(),
  schedule(fn, ms) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
