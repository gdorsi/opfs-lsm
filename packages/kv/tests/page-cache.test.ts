import { describe, expect, it } from "vitest";
import { allMissed, Miss, untilHit } from "../src/store/cursor.js";
import { metaKey, pageKey, PageCache, type Admit } from "../src/store/page-cache.js";

function harness(budget: number) {
  const cache = new PageCache(budget);
  let loads = 0;
  const fetch = (key: number, admit: Admit, bytes: number) =>
    untilHit(() =>
      cache.lookup(key, admit, async () => {
        loads++;
        return { value: key, bytes };
      }),
    );
  const isResident = (key: number) => !(cache.lookup(key, "probation", async () => ({ value: key, bytes: 0 })) instanceof Miss);
  return { cache, fetch, isResident, loads: () => loads };
}

describe("page cache", () => {
  it("a one-pass scan does not evict pages that gets admitted", async () => {
    const { cache, fetch, isResident } = harness(100_000);
    const hot = Array.from({ length: 50 }, (_, i) => pageKey(0, i));
    for (const key of hot) await fetch(key, "main", 1_000);
    for (let p = 0; p < 1_000; p++) await fetch(pageKey(1, p), "probation", 1_000);
    expect(cache.usage().resident).toBeLessThanOrEqual(100_000);
    expect(hot.filter(isResident)).toEqual(hot);
  });

  it("evicts metadata only when no page can go", async () => {
    const { cache, fetch, isResident } = harness(10_000);
    await fetch(metaKey(0), "meta", 3_000);
    for (let p = 0; p < 20; p++) await fetch(pageKey(1, p), "main", 1_000);
    expect(isResident(metaKey(0))).toBe(true);
    expect(cache.usage().metadata).toBe(3_000);

    await fetch(pageKey(2, 0), "main", 9_500);
    expect(cache.usage()).toMatchObject({ resident: 9_500, metadata: 0 });
  });

  it("a read gets a value larger than the budget with one load", async () => {
    const { cache, fetch, loads } = harness(1_000);
    expect(await fetch(pageKey(0, 0), "main", 1_500)).toBe(pageKey(0, 0));
    expect(loads()).toBe(1);
    expect(cache.usage().resident).toBe(0);
  });

  it("stays within budget while concurrent misses land", async () => {
    const { cache, fetch, loads } = harness(2_000);
    const keys = Array.from({ length: 50 }, (_, i) => pageKey(0, i));
    expect(await Promise.all(keys.map((key) => fetch(key, "main", 1_000)))).toEqual(keys);
    expect(loads()).toBe(50);
    expect(cache.usage().resident).toBeLessThanOrEqual(2_000);
  });

  it("one read of many keys ends when they outweigh the budget", async () => {
    const cache = new PageCache(32_000);
    let loads = 0;
    const keys = Array.from({ length: 9_000 }, (_, i) => pageKey(0, i));
    const readAll = () => {
      const misses: Miss[] = [];
      for (const key of keys) {
        const v = cache.lookup(key, "main", async () => {
          loads++;
          return { value: key, bytes: 1_000 };
        });
        if (v instanceof Miss) misses.push(v);
      }
      return misses.length > 0 ? allMissed(misses) : keys;
    };
    expect(await untilHit(readAll)).toBe(keys);
    expect(loads).toBe(keys.length);
    expect(cache.usage().resident).toBeLessThanOrEqual(32_000);
  });

  it("drops a run's entries, and a load that lands after the drop", async () => {
    const { cache, fetch, isResident } = harness(100_000);
    await fetch(pageKey(3, 0), "main", 1_000);
    const late = cache.lookup(pageKey(3, 1), "main", async () => ({ value: 1, bytes: 1_000 }));
    cache.dropRun(3);
    await (late as Miss).ready;
    expect(cache.usage()).toMatchObject({ resident: 0, inFlight: 0 });
    expect(isResident(pageKey(3, 0))).toBe(false);
  });
});
