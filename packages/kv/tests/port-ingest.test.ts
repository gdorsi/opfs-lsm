import { afterEach, describe, expect, it } from "vitest";
import {
  EngineHost,
  MemoryFs,
  __resetMemoryFsForTests,
  attachEngineHostPort,
  createPortIngestClient,
  openDb,
} from "../src/index.js";

const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);

async function deleteIdb(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${name}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

afterEach(async () => {
  await deleteIdb("port-db");
  __resetMemoryFsForTests("port-db");
});

describe("MessagePort ingest host (SharedWorker protocol)", () => {
  it("ingests via port so a second writer sees SST data", async () => {
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
    const { port1, port2 } = new MessageChannel();
    attachEngineHostPort(port1, host);
    const ingest = createPortIngestClient(port2);

    const a = await openDb({
      name: "port-db",
      writerId: "w1",
      fs,
      ingest,
    });
    await a.put(utf("k"), utf("v"));
    const { generation } = await a.ingest();
    expect(generation).toBe(1);

    const b = await openDb({
      name: "port-db",
      writerId: "w2",
      fs,
      ingest,
    });
    const got = await b.get(utf("k"));
    expect(got && new TextDecoder().decode(got)).toBe("v");

    await a.close();
    await b.close();
    ingest.close();
    port1.close();
    port2.close();
  });

  it("serializes concurrent ingest calls on one host", async () => {
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
    const a = await openDb({
      name: "port-db",
      writerId: "w1",
      fs,
      ingest: {
        ingest: (n) => host.ingest(n),
        close: () => undefined,
      },
    });
    await a.put(utf("a"), utf("1"));
    const [g1, g2] = await Promise.all([a.ingest(), a.ingest()]);
    // First may publish gen 1; second is empty and returns same generation.
    expect(Math.max(g1.generation, g2.generation)).toBe(1);
    await a.close();
  });

});
