import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "../src/index.js";
import { EngineHost, MemoryFs, createLocalIngestClient, ingest, openHarnessDb } from "../src/testing.js";
import { checkDatabase, deleteWal } from "./sim/check-database.js";

/**
 * design.md, "Destroy": a destroy is one log entry that deletes every key.
 * The writes acked before it are gone, the writes after it land in the
 * empty database, and every handle stays open, so other handles write while
 * it runs.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();
const opened: Db[] = [];
let n = 0;
let name = "";

afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.close()));
  await deleteWal(name);
});

async function keys(db: Db): Promise<string[]> {
  const out: string[] = [];
  for await (const { key } of db.range()) out.push(dec.decode(key));
  return out;
}

describe("dangerousDestroy while another handle keeps writing", () => {
  it("resolves, and leaves exactly the writes that came after it", async () => {
    name = `destroy-under-writes-${++n}`;
    const fs = new MemoryFs();
    const options = { name, fs, ingest: createLocalIngestClient(new EngineHost(() => fs)), maxWalBytes: 1 << 30 };
    const a = await openHarnessDb(options);
    const b = await openHarnessDb(options);
    opened.push(a, b);
    for (let i = 0; i < 8; i++) await a.put(enc.encode(`old-${i}`), enc.encode("x"));
    await ingest(a);
    await a.put(enc.encode("old-tail"), enc.encode("x"));

    const acked: string[] = [];
    let writing = true;
    let started = () => {};
    const underWay = new Promise<void>((resolve) => (started = resolve));
    const writer = (async () => {
      for (let i = 0; writing; i++) {
        const key = `w-${String(i).padStart(6, "0")}`;
        await b.put(enc.encode(key), enc.encode("y"));
        acked.push(key);
        if (acked.length === 3) started();
      }
    })();
    await underWay;

    const outcome = await a.dangerousDestroy().then(
      () => "emptied",
      (err: unknown) => err,
    );
    const ackedAtDestroy = acked.length;
    writing = false;
    await writer;

    expect(outcome).toBe("emptied");
    await a.sync();
    await b.sync();
    const left = await keys(a);
    expect(await keys(b)).toEqual(left);
    expect(left).toEqual(acked.slice(acked.length - left.length));
    for (const key of acked.slice(ackedAtDestroy)) expect(left).toContain(key);
    expect(left.some((key) => key.startsWith("old-"))).toBe(false);
    const report = await checkDatabase(fs, name);
    expect(report.problems).toEqual([]);
    expect(report.state.map((entry) => dec.decode(entry.key))).toEqual(left);
  });
});
