import { afterEach, expect, it } from "vitest";
import { compareBytes } from "../src/bytes.js";
import type { Db } from "../src/index.js";
import { ingest, openHarnessDb } from "../src/testing.js";

const utf = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
let db: Db | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

it("a bounded scan over several runs and the memtable agrees with a model, whatever prefix the bounds share", async () => {
  db = await openHarnessDb({ name: `shared-prefix-${process.pid}`, forceMemory: true });
  const model = new Map<string, string>();
  let seed = 7;
  const rnd = (n: number) => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n;
  const name = () => `idx/${"ab"[rnd(2)]}/${String(rnd(60)).padStart(3, "0")}${rnd(4) === 0 ? "/x" : ""}`;
  // Each round overwrites and deletes keys of earlier rounds, then becomes a run. The last round stays in the memtable.
  for (let round = 0; round < 5; round++) {
    await db.batch((tx) => {
      for (let i = 0; i < 80; i++) {
        const k = name();
        if (rnd(3) === 0) {
          tx.delete(utf(k));
          model.delete(k);
        } else {
          tx.put(utf(k), utf(`${round}:${i}`));
          model.set(k, `${round}:${i}`);
        }
      }
    });
    if (round < 4) await ingest(db);
  }
  const sorted = [...model].sort(([a], [b]) => compareBytes(utf(a), utf(b)));
  const bounds = [
    ["idx/a/", "idx/a/\xff"],
    ["idx/a/010", "idx/a/050"],
    ["idx/a/020", "idx/a/020/y"],
    ["idx/a/03", "idx/b/02"],
    ["idx/", "idx0"],
    ["", "idx/b/030"],
    ["idx/b/055", "zz"],
  ] as const;
  for (const [start, endExclusive] of bounds) {
    for (const reverse of [false, true]) {
      const want = sorted.filter(([k]) => compareBytes(utf(k), utf(start)) >= 0 && compareBytes(utf(k), utf(endExclusive)) < 0);
      const got: [string, string][] = [];
      for await (const e of db.range({ start: utf(start), endExclusive: utf(endExclusive), reverse })) got.push([text(e.key), text(e.value)]);
      expect(got, `${start}..${endExclusive} reverse=${reverse}`).toEqual(reverse ? want.reverse() : want);
      expect(await db.count({ start: utf(start), endExclusive: utf(endExclusive), reverse })).toBe(want.length);
    }
  }
});
