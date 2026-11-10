import { tryLock } from "../locks.js";
import type { SpawnLogWorker } from "./client.js";
import { serveLog } from "./log-worker-boot.js";
import type { SegmentStore } from "./queue-writer.js";

/**
 * Runs a log's message loop on this thread, for Node and for pages with no
 * OPFS. Messages cross a MessageChannel, so they are cloned, bodies are
 * transferred, and each arrives as its own task, as with a dedicated
 * WebWorker. Ending it frees the log's Web Lock, as a terminated dedicated
 * WebWorker does.
 */
export function localLogWorkers(segments: SegmentStore): SpawnLogWorker {
  return (events) => {
    const { port1: page, port2: inside } = new MessageChannel();
    const held = new Set<() => void>();
    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true;
      for (const release of held) release();
      inside.onmessage = null;
    };
    const onMessage = serveLog({
      lock: async (name) => {
        const release = await tryLock(name);
        if (release && ended) release();
        else if (release) held.add(release);
        return ended ? undefined : release;
      },
      segments: async () => segments,
      post: (msg) => {
        if (!ended) inside.postMessage(msg);
      },
      exit: () => {
        end();
        // After the close reply, which is already posted.
        setTimeout(() => inside.close(), 0);
      },
    });
    inside.onmessage = (ev) => onMessage(ev.data);
    page.onmessage = (ev) => events.message(ev.data);
    return {
      post: (msg, transfer) => {
        if (!ended) page.postMessage(msg, transfer);
      },
      terminate: () => {
        end();
        page.close();
        inside.close();
      },
    };
  };
}
