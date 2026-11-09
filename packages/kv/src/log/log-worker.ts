/// <reference lib="webworker" />
/**
 * The dedicated WebWorker each browser Db spawns. It holds the tab's log
 * segments as SyncAccessHandles in the default, exclusive mode, which every
 * browser supports: only this tab ever opens them. Writes are acked once in
 * the file; a flush follows, coalesced over the writes that queued up.
 */
import { checkDbName } from "../check.js";
import type { FromLogWorker, ToLogWorker } from "./client.js";
import { openDbDir } from "../opfs/root.js";
import { LOG_DIR } from "./frame.js";
import { TabWriter, type SegmentFile, type SegmentStore } from "./tab-writer.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;
let writer: Promise<TabWriter> | undefined;

let outbox: FromLogWorker[] = [];
const reply = (msg: FromLogWorker) => {
  if (outbox.length === 0) {
    queueMicrotask(() => {
      const msgs = outbox;
      outbox = [];
      scope.postMessage(msgs);
    });
  }
  outbox.push(msg);
};

let chain: Promise<unknown> = Promise.resolve();

scope.onmessage = (ev: MessageEvent<ToLogWorker>) => {
  const msg = ev.data;
  if (msg.t === "open") {
    writer = openWriter(msg.name, msg.tab, msg.segmentBytes);
    return;
  }
  const run = async () => {
    try {
      const w = await writer!;
      if (msg.t === "close") w.close();
      else if (msg.t === "flush") w.flush();
      else await w.write(msg.frames);
      reply({ t: "done", id: msg.id });
    } catch (err) {
      reply({ t: "err", id: msg.id, message: err instanceof Error ? err.message : String(err) });
    }
  };
  chain = chain.then(run, run);
};

async function openWriter(name: string, tab: string, segmentBytes: number): Promise<TabWriter> {
  const db = await openDbDir(checkDbName(name));
  const log = await db.getDirectoryHandle(LOG_DIR, { create: true });
  const dir = await log.getDirectoryHandle(tab, { create: true });
  const w = new TabWriter(opfsSegments(dir), tab, segmentBytes);
  // Create the first segment now, so the first write does not wait for it.
  await w.prepare();
  return w;
}

function opfsSegments(dir: FileSystemDirectoryHandle): SegmentStore {
  return {
    async create(path) {
      const file = path.slice(path.lastIndexOf("/") + 1);
      const handle = await dir.getFileHandle(file, { create: true });
      return sahFile(await handle.createSyncAccessHandle());
    },
  };
}

function sahFile(sah: FileSystemSyncAccessHandle): SegmentFile {
  return {
    write: (bytes, at) => sah.write(bytes, { at }),
    flush: () => sah.flush(),
    getSize: () => sah.getSize(),
    close: () => sah.close(),
  };
}
