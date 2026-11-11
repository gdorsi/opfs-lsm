import { afterEach, describe, expect, it } from "vitest";
import {
  __resetMemoryFsForTests,
  openHarnessDb,
  type HarnessOpenOptions,
  ingest,
  EngineHost,
  MemoryFs,
  attachEngineHostPort,
  createLocalIngestClient,
  createPortIngestClient,
  type IngestClient,
} from "../src/testing.js";

const NAME = "compaction-memory";
const MiB = 1024 * 1024;
const enc = new TextEncoder();

afterEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  __resetMemoryFsForTests(NAME);
});

/**
 * The L0 runs a host cuts 110 puts of 40,004 op bytes into after `budgets`
 * tabs opened. `hostBudget` gives a run 0.875, 1.75 and 3.5 MiB at 16, 32 and
 * 64 MiB, which holds 22, 45 and 91 of these puts.
 */
async function runsFlushed(
  budgets: readonly (number | undefined)[],
  connect: (host: EngineHost) => { client: IngestClient; close: () => void } = (host) => ({
    client: createLocalIngestClient(host),
    close: () => undefined,
  }),
): Promise<number> {
  const fs = new MemoryFs();
  const host = new EngineHost(() => fs);
  const { client, close } = connect(host);
  const tabs = [];
  for (const [i, compactionMemoryBytes] of budgets.entries()) {
    const options: HarnessOpenOptions = {
      name: NAME,
      writerId: `w${i}`,
      fs,
      ingest: client,
      ingestPolicy: { maxWalBytes: 1e12 },
      ...(compactionMemoryBytes === undefined ? {} : { compactionMemoryBytes }),
    };
    tabs.push(await openHarnessDb(options));
  }
  const value = new Uint8Array(40_000);
  for (let i = 0; i < 110; i++) await tabs[0]!.put(enc.encode(`k${String(i).padStart(3, "0")}`), value);
  await ingest(tabs[0]!);
  await host.ingest(NAME, Number.POSITIVE_INFINITY, true);
  const { flushes } = await host.stats(NAME);
  await Promise.all(tabs.map((tab) => tab.close()));
  close();
  return flushes;
}

describe("openDb({ compactionMemoryBytes })", () => {
  it("is 32 MiB unless set", async () => {
    expect(await runsFlushed([undefined])).toBe(3);
  });

  it("sizes the host's flush runs", async () => {
    expect(await runsFlushed([64 * MiB])).toBe(2);
    expect(await runsFlushed([16 * MiB])).toBe(5);
  });

  it.each([
    [[64 * MiB, 16 * MiB]],
    [[16 * MiB, 64 * MiB]],
    [[undefined, 16 * MiB]],
    [[Number.NaN, 16 * MiB]],
    [[16 * MiB, Number.NaN]],
  ])("holds the host to the smallest budget any tab passed: %j", async (budgets) => {
    expect(await runsFlushed(budgets)).toBe(5);
  });

  it("reaches a host behind a MessagePort", async () => {
    const flushes = await runsFlushed([16 * MiB], (host) => {
      const { port1, port2 } = new MessageChannel();
      const detach = attachEngineHostPort(port1, host);
      const client = createPortIngestClient(port2);
      return {
        client,
        close: () => {
          client.close();
          detach();
          port1.close();
        },
      };
    });

    expect(flushes).toBe(5);
  });

  it("keeps the smallest budget when a tab of an older build sends none", async () => {
    const flushes = await runsFlushed([16 * MiB], (host) => {
      const { port1, port2 } = new MessageChannel();
      const detach = attachEngineHostPort(port1, host);
      port2.postMessage({ type: "watch", name: NAME, maxWalBytes: 1e12 });
      const client = createPortIngestClient(port2);
      return {
        client,
        close: () => {
          client.close();
          detach();
          port1.close();
        },
      };
    });

    expect(flushes).toBe(5);
  });
});
