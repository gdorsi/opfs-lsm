import { CONTROL_BYTES, DONE, FILE, LEN, OFF_HI, OFF_LO, REQ, STATUS, WAKE, type FromWorker, type ToWorker } from "./sync-read-protocol.js";

/**
 * Dedicated worker entry. `@opfs-lsm/kv/sync-reads` starts it via
 * `import.meta.url`. It holds a read-only sync access handle per open run
 * file and answers the tab's reads through the shared buffer. It reads its
 * globals off `globalThis` so the main tsc build needs no webworker lib.
 */
type SyncHandle = {
  read(into: Uint8Array, options: { at: number }): number;
  close(): void;
};
type FileHandle = { createSyncAccessHandle(options: { mode: "read-only" }): Promise<SyncHandle> };

const scope = globalThis as unknown as {
  onmessage: ((ev: MessageEvent<ToWorker>) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage(message: FromWorker): void;
  FileSystemSyncAccessHandle?: { prototype: object };
};

/** Loads of `WAKE` after a read before the worker parks. A read that arrives meanwhile waits for no wake-up. */
const SPIN = 4_000;

const handles = new Map<number, SyncHandle>();
/** Directory handles by path, so a file open costs two calls to the browser process. */
const folders = new Map<string, Promise<FileSystemDirectoryHandle>>();

function folder(path: string): Promise<FileSystemDirectoryHandle> {
  let found = folders.get(path);
  if (!found) {
    found = path
      .split("/")
      .reduce((parent, name) => parent.then((dir) => dir.getDirectoryHandle(name)), navigator.storage.getDirectory());
    folders.set(path, found);
  }
  return found;
}

async function open(m: Extract<ToWorker, { kind: "open" }>): Promise<void> {
  let ok = false;
  try {
    const file = await (await folder(m.folder)).getFileHandle(m.name);
    handles.set(m.file, await (file as unknown as FileHandle).createSyncAccessHandle({ mode: "read-only" }));
    ok = true;
  } catch {
    // The folder may have been removed and made again since its handle was kept: the next open looks it up.
    folders.delete(m.folder);
  }
  scope.postMessage({ kind: "done", id: m.id, ok });
}

/**
 * Answers reads for the life of the worker. It parks on `Atomics.waitAsync`,
 * never `Atomics.wait`: a blocked worker takes no `open` or `close` and
 * answers no DevTools command.
 */
async function serve(ctl: Int32Array, data: Uint8Array): Promise<never> {
  let served = 0;
  const answer = (): void => {
    const id = Atomics.load(ctl, REQ);
    if (id === served) return;
    let read = -1;
    try {
      const at = (ctl[OFF_LO]! >>> 0) + ctl[OFF_HI]! * 0x1_0000_0000;
      read = handles.get(ctl[FILE]!)?.read(data.subarray(0, ctl[LEN]), { at }) ?? -1;
    } catch {
      // The tab reads it the async way, which reports what is wrong with the file.
    }
    ctl[STATUS] = read;
    served = id;
    Atomics.store(ctl, DONE, id);
  };
  for (;;) {
    let wake = Atomics.load(ctl, WAKE);
    answer();
    for (let i = 0; i < SPIN; i++) {
      const now = Atomics.load(ctl, WAKE);
      if (now !== wake) {
        wake = now;
        answer();
        i = 0;
      }
    }
    const parked = Atomics.waitAsync(ctl, WAKE, wake);
    if (parked.async) await parked.value;
  }
}

scope.onmessage = ({ data: m }) => {
  if (m.kind === "open") void open(m);
  else if (m.kind === "close") {
    handles.get(m.file)?.close();
    handles.delete(m.file);
    scope.postMessage({ kind: "done", id: m.id, ok: true });
  } else {
    const supported = typeof Atomics.waitAsync === "function" && "mode" in (scope.FileSystemSyncAccessHandle?.prototype ?? {});
    if (supported) void serve(new Int32Array(m.buffer, 0, CONTROL_BYTES / 4), new Uint8Array(m.buffer, CONTROL_BYTES));
    scope.postMessage({ kind: "init", supported });
  }
};

// Only `init` carries something that can fail to arrive: the buffer.
scope.onmessageerror = () => scope.postMessage({ kind: "init", supported: false });
