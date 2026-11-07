import { afterEach, describe, expect, it } from "vitest";
import { EngineHost, MemoryFs, createLocalIngestClient } from "../../src/index.js";
import { openHarnessDb } from "../../src/testing.js";
import { deleteWal } from "./check-database.js";

/**
 * Bugs the model suite found, reduced to plain tests. A failing one is
 * marked `it.fails` until the engine is fixed; then drop the `.fails`.
 */

const utf = (s: string) => new TextEncoder().encode(s);
const NAME = "sim-regressions";

afterEach(() => deleteWal(NAME));

async function open() {
  const fs = new MemoryFs();
  return openHarnessDb({ name: NAME, fs, ingest: createLocalIngestClient(new EngineHost(() => fs)) });
}

describe("model suite regressions", () => {
  // Found by model.test.ts, seed -2023477141, shrunk to:
  //   [view[range {}] with put "" 0a before read 0, view[range {"limit":0}]]
  // `mergeCursors` and `scanMatching` checked the limit after yielding, so
  // `limit: 0` yielded one entry.
  it("range with limit 0 returns nothing", async () => {
    const db = await open();
    await db.put(utf("a"), utf("1"));
    const out = [];
    for await (const e of db.range({ limit: 0 })) out.push(e);
    await db.close();
    expect(out).toEqual([]);
  });
});
