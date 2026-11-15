/**
 * `?fault=1`: a DocStorage whose flush rejects while switched on. The writes themselves still go to the real
 * storage, so turning it off lets the model's own retry (the autosave period after an error) reach "saved".
 * It exists for one browser proof: a storage error is visible, and goes away by itself when storage recovers.
 */
import type { DocStorage } from "../model/index.ts";

export type FaultSwitch = { on(): void; off(): void };

export function faultable(inner: DocStorage): { readonly storage: DocStorage; readonly switch: FaultSwitch } {
  let failing = false;
  const storage: DocStorage = {
    async attach(name, doc) {
      const binding = await inner.attach(name, doc);
      return {
        ...binding,
        flush: () => (failing ? Promise.reject(new Error("injected storage fault")) : binding.flush()),
        detach: () => binding.detach(),
        clear: () => binding.clear(),
      };
    },
  };
  return { storage, switch: { on: () => void (failing = true), off: () => void (failing = false) } };
}
