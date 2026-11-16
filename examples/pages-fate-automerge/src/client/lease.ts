import type { Bodies } from "../model/bodies.ts";
import type { PageBody, PageId } from "../model/types.ts";

const CLOSE_AFTER_MS = 5000;

export type Lease = { readonly body: Promise<PageBody>; release(): void };

export type Leases = {
  lease(id: PageId): Lease;
  flush(): Promise<void>;
};

export function bodyLeases(bodies: Pick<Bodies, "open">): Leases {
  type Entry = { holders: number; readonly body: Promise<PageBody>; timer?: ReturnType<typeof setTimeout> };
  const entries = new Map<PageId, Entry>();
  return {
    lease(id) {
      let entry = entries.get(id);
      if (!entry) {
        const opened: Entry = { holders: 0, body: bodies.open(id) };
        opened.body.catch(() => entries.get(id) === opened && entries.delete(id));
        entries.set(id, (entry = opened));
      }
      const held = entry;
      clearTimeout(held.timer);
      held.holders++;
      let released = false;
      return {
        body: held.body,
        release() {
          if (released) return;
          released = true;
          if (--held.holders > 0) return;
          held.timer = setTimeout(() => {
            entries.delete(id);
            held.body.then((body) => body.close()).catch((error: unknown) => console.warn(`pages: could not close ${id}`, error));
          }, CLOSE_AFTER_MS);
        },
      };
    },
    async flush() {
      await Promise.allSettled([...entries.values()].map(async (entry) => (await entry.body).flush()));
    },
  };
}
