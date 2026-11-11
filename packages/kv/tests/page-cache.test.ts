import { describe, expect, it } from "vitest";
import { Miss, untilHit } from "../src/store/cursor.js";
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

  it("keeps a filled entry until its retry, even past the budget", async () => {
    const { cache, fetch, loads } = harness(1_000);
    await fetch(pageKey(0, 0), "main", 1_500);
    expect(loads()).toBe(1);
    expect(cache.usage()).toMatchObject({ resident: 0, pinned: 0 });

    const miss = cache.lookup(pageKey(0, 1), "main", async () => ({ value: 1, bytes: 800 }));
    expect(miss).toBeInstanceOf(Miss);
    await (miss as Miss).ready;
    expect(cache.usage()).toMatchObject({ resident: 800, pinned: 800 });
    expect(cache.lookup(pageKey(0, 1), "main", () => Promise.reject(new Error("reloaded")))).toBe(1);
    expect(cache.usage().pinned).toBe(0);
  });

  it("is back within budget once concurrent misses have retried", async () => {
    const { cache, fetch, loads } = harness(2_000);
    const keys = Array.from({ length: 50 }, (_, i) => pageKey(0, i));
    expect(await Promise.all(keys.map((key) => fetch(key, "main", 1_000)))).toEqual(keys);
    expect(loads()).toBe(50);
    const usage = cache.usage();
    expect(usage.pinned).toBe(0);
    expect(usage.resident).toBeLessThanOrEqual(2_000);
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
