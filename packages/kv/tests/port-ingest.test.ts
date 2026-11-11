import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EngineHost,
  MemoryFs,
  attachEngineHostPort,
  createLocalIngestClient,
  createPortIngestClient
} from "../src/index.js";
import {
  openHarnessDb,
  __resetMemoryFsForTests,
  ingest as ingestDb,
} from "../src/testing.js";
import { CorruptDatabaseError, OpfsLsmError } from "../src/errors.js";
import { loadLatestGeneration } from "../src/store/generation.js";

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
  it("a host error crosses the port as the same error class", async () => {
    const fs = new MemoryFs();
    const db = await openHarnessDb({ name: "port-db", fs, ingest: createLocalIngestClient(new EngineHost(() => fs)) });
    await db.put(utf("k"), utf("v"));
    await ingestDb(db);
    await db.close();
    // The recorded manifest no longer decodes: the host refuses to flush.
    const [name] = await fs.list("m");
    const body = (await fs.read(`m/${name}`, 0, Number.POSITIVE_INFINITY))!.slice();
    body[20]! ^= 1;
    const w = await fs.create(`m/${name}`);
    await w.write(body);
    await w.finish();
    const { port1, port2 } = new MessageChannel();
    attachEngineHostPort(port1, new EngineHost(() => fs));
    const client = createPortIngestClient(port2);
    const err = await client.ingest("port-db", 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CorruptDatabaseError);
    expect((err as OpfsLsmError).code).toBe("corrupt");
    client.close();
    port1.close();
  });

  it("ingests via port so a second writer sees SST data", async () => {
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
    const { port1, port2 } = new MessageChannel();
    attachEngineHostPort(port1, host);
    const ingest = createPortIngestClient(port2);

    const a = await openHarnessDb({
      name: "port-db",
      writerId: "w1",
      fs,
      ingest,
    });
    await a.put(utf("k"), utf("v"));
    const { generation } = await ingestDb(a);
    expect(generation).toBe(1);

    const b = await openHarnessDb({
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

  it("the host behind the port ingests once the WAL passes maxWalBytes", async () => {
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
    const { port1, port2 } = new MessageChannel();
    attachEngineHostPort(port1, host);
    const ingest = createPortIngestClient(port2);
    const db = await openHarnessDb({
      name: "port-db",
      writerId: "w1",
      fs,
      ingest,
      ingestPolicy: { maxWalBytes: 100 },
    });
    await new Promise((r) => setTimeout(r, 100));
    await db.put(utf("k"), new Uint8Array(150));
    await vi.waitFor(
      async () => expect((await loadLatestGeneration(fs))?.runs).toHaveLength(1),
      { timeout: 2000, interval: 5 },
    );
    await db.close();
    ingest.close();
    port1.close();
    port2.close();
  });

  it("serializes concurrent ingest calls on one host", async () => {
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
    const a = await openHarnessDb({
      name: "port-db",
      writerId: "w1",
      fs,
      ingest: createLocalIngestClient(host),
    });
    await a.put(utf("a"), utf("1"));
    const [g1, g2] = await Promise.all([ingestDb(a), ingestDb(a)]);
    // First may publish gen 1; second is empty and returns same generation.
    expect(Math.max(g1.generation, g2.generation)).toBe(1);
    await a.close();
  });

});
