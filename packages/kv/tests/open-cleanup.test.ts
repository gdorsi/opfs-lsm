import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CorruptDatabaseError } from "../src/index.js";
import {
  EngineHost,
  MemoryFs,
  createLocalIngestClient,
  ingest,
  openHarnessDb,
} from "../src/testing.js";

const enc = new TextEncoder();
let names = 0;

/** What a page still holds: IndexedDB connections and BroadcastChannels not yet closed. */
function watchHandles() {
  const idb = new Set<IDBDatabase>();
  const channels = new Set<BroadcastChannel>();
  const realOpen = indexedDB.open.bind(indexedDB);
  vi.spyOn(indexedDB, "open").mockImplementation((...args) => {
    const req = realOpen(...args);
    req.addEventListener("success", () => {
      const db = req.result;
      const close = db.close.bind(db);
      idb.add(db);
      db.close = () => {
        idb.delete(db);
        close();
      };
    });
    return req;
  });
  const RealChannel = globalThis.BroadcastChannel;
  class CountedChannel extends RealChannel {
    constructor(name: string) {
      super(name);
      channels.add(this);
    }
    override close(): void {
      channels.delete(this);
      super.close();
    }
  }
  vi.stubGlobal("BroadcastChannel", CountedChannel);
  return { idb, channels };
}

let handles: ReturnType<typeof watchHandles>;
const open = () => ({ idb: handles.idb.size, channels: handles.channels.size });

beforeEach(() => {
  handles = watchHandles();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function storedDatabase() {
  const name = `open-cleanup-${++names}`;
  const fs = new MemoryFs();
  const client = createLocalIngestClient(new EngineHost(() => fs));
  const options = { name, fs, ingest: client, maxWalBytes: 1 << 30 };
  const db = await openHarnessDb(options);
  for (let i = 0; i < 20; i++) await db.put(enc.encode(`k${i}`), enc.encode("v"));
  await ingest(db);
  await db.close();
  expect(open()).toEqual({ idb: 0, channels: 0 });
  return { fs, options };
}

describe("a failed openDb", () => {
  it("leaves no IndexedDB connection open when recovery meets a manifest that does not decode", async () => {
    const { fs, options } = await storedDatabase();
    const manifest = fs.publishedPaths().find((path) => path.startsWith("m/"))!;
    await fs.remove(manifest);
    const garbage = await fs.create(manifest);
    await garbage.write(enc.encode("not a manifest"));
    await garbage.finish();

    // A name whose IndexedDB records no manifest, so recovery reads the ones in `m/`.
    await expect(openHarnessDb({ ...options, name: `${options.name}-fresh-idb` })).rejects.toBeInstanceOf(
      CorruptDatabaseError,
    );

    expect(open()).toEqual({ idb: 0, channels: 0 });
  });

  it("leaves no IndexedDB connection or BroadcastChannel open when the first sync finds a recorded run missing", async () => {
    const { fs, options } = await storedDatabase();
    for (const path of fs.publishedPaths().filter((path) => !path.startsWith("m/"))) await fs.remove(path);

    await expect(openHarnessDb(options)).rejects.toBeInstanceOf(CorruptDatabaseError);

    expect(open()).toEqual({ idb: 0, channels: 0 });
  });
});
