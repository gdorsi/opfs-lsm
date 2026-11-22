import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openHarnessDb,
  __resetMemoryFsForTests,
  ingest as ingestDb,
  EngineHost,
  MemoryFs,
  attachEngineHostPort,
  createLocalIngestClient,
  createPortIngestClient,
} from "../src/testing.js";
import {
  ClosedError,
  CommitError,
  ConstraintError,
  CorruptDatabaseError,
  OpfsLsmError,
  StorageUnavailableError,
} from "../src/errors.js";
import { loadLatestGeneration } from "./latest-generation.js";
import { walStore } from "./sim/check-database.js";

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
    const err = await client.ingest("port-db").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CorruptDatabaseError);
    expect((err as OpfsLsmError).code).toBe("corrupt");
    client.close();
    port1.close();
  });

  /** A database whose flush OPFS kept and whose WAL database the browser threw away. */
  async function flushedThenWalLost(): Promise<MemoryFs> {
    const fs = new MemoryFs();
    const db = await openHarnessDb({ name: "port-db", fs, ingest: createLocalIngestClient(new EngineHost(() => fs)) });
    await db.put(utf("k"), utf("v"));
    await ingestDb(db);
    await db.close();
    await deleteIdb("port-db");
    return fs;
  }

  it("an open has the host repair over the port, and reads what the repair recorded", async () => {
    const fs = await flushedThenWalLost();
    const { port1, port2 } = new MessageChannel();
    attachEngineHostPort(port1, new EngineHost(() => fs));
    const posted = vi.spyOn(port2, "postMessage");
    const db = await openHarnessDb({ name: "port-db", fs, ingest: createPortIngestClient(port2) });
    expect(posted.mock.calls.filter(([msg]) => (msg as { type: string }).type === "repair")).toHaveLength(1);
    expect(await db.get(utf("k"))).toEqual(utf("v"));
    expect(await db.put(utf("k2"), utf("v2"))).toBe(2);
    await db.close();
    port1.close();
  });

  it("an open rejects with the class of the host's refusal to repair", async () => {
    const fs = await flushedThenWalLost();
    const [name] = await fs.list("m");
    const body = (await fs.read(`m/${name}`, 0, Number.POSITIVE_INFINITY))!.slice();
    body[20]! ^= 1;
    const w = await fs.create(`m/${name}`);
    await w.write(body);
    await w.finish();
    const { port1, port2 } = new MessageChannel();
    attachEngineHostPort(port1, new EngineHost(() => fs));
    const client = createPortIngestClient(port2);
    await expect(openHarnessDb({ name: "port-db", fs, ingest: client })).rejects.toThrow(CorruptDatabaseError);
    client.close();
    port1.close();
  });

  it("answers a request it does not know, so a newer tab does not wait forever", async () => {
    const { port1, port2 } = new MessageChannel();
    attachEngineHostPort(port1, new EngineHost(() => new MemoryFs()));
    const reply = new Promise<{ type: string; id: number; code?: string }>((resolve) => {
      port2.onmessage = (ev) => resolve(ev.data);
    });
    port2.postMessage({ type: "from-a-newer-build", id: 7, name: "port-db" });
    expect(await reply).toMatchObject({ type: "err", id: 7, code: new StorageUnavailableError("").code });
    port1.close();
    port2.close();
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
      maxWalBytes: 100,
    });
    await new Promise((r) => setTimeout(r, 100));
    await db.put(utf("k"), new Uint8Array(150));
    await vi.waitFor(
      async () => expect((await loadLatestGeneration(fs))?.runs).toHaveLength(1),
      { timeout: 2000, interval: 5 },
    );
    // The manifest is on disk before the host records it and compacts. Wait for
    // the host to go idle, or it writes to the next test's WAL of the same name.
    await ingestDb(db);
    await db.close();
    ingest.close();
    port1.close();
    port2.close();
  });

  it("destroys over the port", async () => {
    const fs = new MemoryFs();
    const { port1, port2 } = new MessageChannel();
    attachEngineHostPort(port1, new EngineHost(() => fs));
    const client = createPortIngestClient(port2);
    const db = await openHarnessDb({ name: "port-db", fs, ingest: client });
    await db.put(utf("k"), utf("v"));
    await ingestDb(db);
    await db.dangerousDestroy();
    expect(await db.get(utf("k"))).toBeUndefined();
    await db.close();
    client.close();
    port1.close();
  });

  it("stops holding the host to a tab's maxWalBytes once the last tab closes", async () => {
    const fs = new MemoryFs();
    const { port1, port2 } = new MessageChannel();
    attachEngineHostPort(port1, new EngineHost(() => fs));
    const client = createPortIngestClient(port2);
    const small = await openHarnessDb({ name: "port-db", writerId: "small", fs, ingest: client, maxWalBytes: 100 });
    await small.close();
    const large = await openHarnessDb({ name: "port-db", writerId: "large", fs, ingest: client, maxWalBytes: 1e9 });
    await new Promise((r) => setTimeout(r, 100));
    await large.put(utf("k"), new Uint8Array(150));
    await new Promise((r) => setTimeout(r, 200));
    expect(await loadLatestGeneration(fs)).toBeUndefined();
    await large.close();
    client.close();
    port1.close();
  });

  it("a host error crosses the port with its class, whatever its code", async () => {
    const fs = new MemoryFs();
    const db = await openHarnessDb({ name: "port-db", fs, ingest: createLocalIngestClient(new EngineHost(() => fs)) });
    await db.put(utf("k"), utf("v"));
    await db.close();
    // A row that is not an ArrayBuffer: the host's flush cannot decode it.
    await walStore("port-db", "readwrite", (wal) => wal.put("not a row", 1));
    const { port1, port2 } = new MessageChannel();
    attachEngineHostPort(port1, new EngineHost(() => fs));
    const client = createPortIngestClient(port2);
    const cases = [
      { what: "a WAL row the host cannot decode", call: () => client.ingest("port-db"), error: CommitError },
      { what: "a database that is not there", call: () => client.ingest("port-none"), error: ClosedError },
      { what: "a name no database can have", call: () => client.stats("not a name"), error: ConstraintError },
    ];
    const got = [];
    for (const { what, call } of cases) {
      const err = await call().catch((e: unknown) => e);
      got.push({ what, name: (err as Error).name, code: (err as OpfsLsmError).code });
    }
    expect(got).toEqual(cases.map(({ what, error }) => ({ what, name: error.name, code: new error("").code })));
    client.close();
    port1.close();
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
