import { expect } from "vitest";
import type { Db, ViewSnapshot } from "../src/index.js";
import type { AsyncFs } from "../src/opfs/async-fs.js";
import { EngineHost, MemoryFs, createLocalIngestClient, ingest, openHarnessDb } from "../src/testing.js";

const utf = (s: string) => new TextEncoder().encode(s);
let n = 0;

/**
 * Runs `read` on a view of a handle that has read no run page yet, over
 * three L0 runs holding k0=v0, k1=v1 and k2=v2. The view's callback returns
 * while the read waits for its first page. Then a compaction replaces the
 * three runs, the handle installs its output, and the host removes every run
 * file no tab holds, before the page arrives. `outcome` is what the read
 * settled with, and `kept` says whether the three runs were still on disk
 * when its page arrived. Every handle it opens is pushed to `opened`.
 */
export async function readPastViewCallback(
  read: (snap: ViewSnapshot) => Promise<unknown>,
  opened: Db[],
): Promise<{ outcome: { value: unknown } | { error: string }; kept: boolean }> {
  const fs = new MemoryFs();
  const host = new EngineHost(() => fs);
  const name = `view-read-${process.pid}-${++n}`;
  const db = await openHarnessDb({ name, writerId: "w", fs, ingest: createLocalIngestClient(host), maxWalBytes: 1e12 });
  opened.push(db);
  // Three L0 runs: one more flush starts a compaction into L1.
  for (let i = 0; i < 3; i++) {
    await db.put(utf(`k${i}`), utf(`v${i}`));
    await ingest(db);
  }
  const l0 = () => fs.publishedPaths().filter((p) => p.startsWith("l0/"));
  const inputs = l0();
  expect(inputs).toHaveLength(3);

  let lift = () => {};
  let arrived = () => {};
  let gate: Promise<void> | undefined;
  const gated: AsyncFs = {
    read: (path, offset, length) => fs.read(path, offset, length),
    list: (dir) => fs.list(dir),
    remove: (path) => fs.remove(path),
    removeUnlessOpen: (path) => fs.removeUnlessOpen(path),
    create: (path) => fs.create(path),
    open: async (path) => {
      const file = await fs.open(path);
      return (
        file && {
          size: file.size,
          read: async (offset, length) => {
            if (gate) {
              arrived();
              await gate;
            }
            return file.read(offset, length);
          },
          close: () => file.close(),
        }
      );
    },
  };
  const reader = await openHarnessDb({ name, writerId: "r", fs: gated, ingest: createLocalIngestClient(host), maxWalBytes: 1e12 });
  opened.push(reader);
  gate = new Promise((resolve) => (lift = resolve));
  const waiting = new Promise<void>((resolve) => (arrived = resolve));
  const { settled } = await reader.view((snap) => ({
    settled: read(snap).then(
      (value) => ({ value }),
      (error: unknown) => ({ error: String(error) }),
    ),
  }));
  await waiting;

  await db.put(utf("k3"), utf("v3"));
  await ingest(db);
  await ingest(db);
  await reader.sync();
  await ingest(db);
  const kept = inputs.every((path) => l0().includes(path));

  gate = undefined;
  lift();
  return { outcome: await settled, kept };
}
