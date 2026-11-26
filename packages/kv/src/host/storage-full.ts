import type { DbName } from "../check.js";
import { fullLock, webLocks } from "../locks.js";
import type { BusMessage, StorageFull } from "./protocol.js";

type StorageFullHandler = (full: StorageFull) => Promise<void>;

/** A tab's side of the reserve offer (docs/reserve.md, "Answer"). */
export type StorageFullResponder = {
  /** Add a handler. While this handle has one, it asks for the full lock. Returns unsubscribe. */
  readonly on: (handler: StorageFullHandler) => () => void;
  /**
   * Answer an offer. The holder of the full lock runs its handlers. A
   * handle with no handler answers when no handle holds the lock, so the
   * host tries the reserve again once space is free.
   */
  readonly answer: (full: StorageFull) => Promise<void>;
  /** Let go of the lock, and answer no more. Before the channel closes. */
  readonly close: () => void;
};

export function storageFullResponder(name: DbName, bus: BroadcastChannel | undefined): StorageFullResponder {
  const handlers = new Set<StorageFullHandler>();
  /** Lets go of the full lock, or of the wait for it. Set while this handle has a handler. */
  let unlock: (() => void) | undefined;
  let holding = false;
  let answering = false;
  /** This handle has said once that no tab has a handler. */
  let warned = false;
  let closed = false;
  const post = (message: BusMessage) => bus?.postMessage(message);

  const askLock = () => {
    const abort = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const mine = (unlock = () => {
      unlock = undefined;
      holding = false;
      abort.abort();
      release();
    });
    webLocks()
      ?.request(fullLock(name), { signal: abort.signal }, () => {
        // Granted before `unlock` could abort the request: `held` is settled, so the lock goes back.
        if (unlock !== mine) return held;
        holding = true;
        post({ kind: "full-pull" });
        return held;
      })
      .catch(() => undefined);
  };

  return {
    on(handler) {
      const own: StorageFullHandler = (full) => handler(full);
      handlers.add(own);
      if (!unlock) askLock();
      return () => {
        if (handlers.delete(own) && handlers.size === 0) unlock?.();
      };
    },
    async answer(full) {
      if (holding && !answering) {
        answering = true;
        for (const handler of [...handlers]) {
          try {
            await handler(full);
          } catch (err) {
            console.error(`opfs-lsm: an onStorageFull handler of ${name} failed`, err);
          }
        }
        answering = false;
        // A handle that let go of the lock meanwhile stays silent, so the next holder pulls the offer.
        if (holding) post({ kind: "full-done" });
      } else if (handlers.size === 0) {
        const free = await webLocks()?.request(fullLock(name), { mode: "shared", ifAvailable: true }, (lock) => lock !== null);
        if (!free || closed) return;
        if (!warned) {
          warned = true;
          console.warn(
            `opfs-lsm: the browser refused a write to ${name}, and no tab has an onStorageFull handler to free ${full.need} bytes`,
          );
        }
        post({ kind: "full-done" });
      }
    },
    close() {
      closed = true;
      unlock?.();
    },
  };
}
