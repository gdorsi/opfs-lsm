import { afterEach, expect, it } from "vitest";
import type { Db } from "../src/index.js";
import { ingest, openHarnessDb } from "../src/testing.js";

/** `valueContains` edge patterns: empty pattern, pattern longer than the value, empty values, repeated patterns, in the memtable and in a run. */
const utf = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
let db: Db | undefined;
let n = 0;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

const ROWS: [string, string][] = [
  ["a", ""],
  ["b", "x"],
  ["c", "xy"],
  ["d", "yx"],
  ["e", "xxy"],
  ["f", "z".repeat(5000) + "xy"],
  ["g", "xy" + "z".repeat(40000)],
];

const cases: [string, Uint8Array[]][] = [
  ["empty pattern", [new Uint8Array(0)]],
  ["x", [utf("x")]],
  ["xy", [utf("xy")]],
  ["x and y", [utf("x"), utf("y")]],
  ["xy twice", [utf("xy"), utf("xy")]],
  ["longer than any short value", [utf("xyz")]],
  ["zx", [utf("zx")]],
  ["empty and y", [new Uint8Array(0), utf("y")]],
];

const contains = (v: string, ps: Uint8Array[]) => ps.every((p) => v.includes(text(p)));

for (const where of ["memtable", "run", "both"] as const) {
  it(`valueContains agrees with a substring check (${where})`, async () => {
    db = await openHarnessDb({ name: `value-contains-edges-${process.pid}-${++n}`, forceMemory: true });
    const half = where === "both" ? 4 : ROWS.length;
    await db.batch((tx) => ROWS.slice(0, half).forEach(([k, v]) => tx.put(utf(k), utf(v))));
    if (where !== "memtable") await ingest(db);
    await db.batch((tx) => ROWS.slice(half).forEach(([k, v]) => tx.put(utf(k), utf(v))));
    for (const [label, patterns] of cases) {
      for (const reverse of [false, true]) {
        const want = ROWS.filter(([, v]) => contains(v, patterns)).map(([k]) => k);
        if (reverse) want.reverse();
        const got: string[] = [];
        for await (const e of db.range({ valueContains: patterns, reverse })) got.push(text(e.key));
        expect(got, `${label} reverse ${reverse}`).toEqual(want);
        expect(await db.count({ valueContains: patterns, reverse }), `${label} count`).toBe(want.length);
      }
    }
  });
}
