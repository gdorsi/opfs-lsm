import type { DocStorage } from "../model/index.ts";

type FaultSwitch = { on(): void; off(): void };

export function faultable(inner: DocStorage): { readonly storage: DocStorage; readonly switch: FaultSwitch } {
  let failing = false;
  const storage: DocStorage = {
    async attach(name, doc) {
      const binding = await inner.attach(name, doc);
      return {
        ...binding,
        flush: () => (failing ? Promise.reject(new Error("injected storage fault")) : binding.flush()),
      };
    },
  };
  return { storage, switch: { on: () => void (failing = true), off: () => void (failing = false) } };
}
