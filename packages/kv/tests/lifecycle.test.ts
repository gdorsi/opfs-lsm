import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineHost, MemoryFs, createLocalIngestClient, type Db } from "../src/index.js";
import { openHarnessDb } from "../src/testing.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);
const str = (b: Uint8Array | undefined) => (b ? dec.decode(b) : undefined);

/** The page whose code this is, so its channels freeze with it. */
const pages = new AsyncLocalStorage<Page>();

/**
 * A page the browser can freeze, as on `freeze` or `pagehide` into the
 * back/forward cache: its lifecycle handlers run first, then nothing reaches
 * it and nothing leaves it until it resumes.
 */
class Page {
  frozen = false;
  private held: (() => void)[] = [];
  private on: { suspend(): void; resume(): void } | undefined;

  readonly lifecycle = (on: { suspend(): void; resume(): void }) => {
    this.on = on;
    return () => {
      this.on = undefined;
    };
  };

  run<T>(fn: () => T): T {
    return pages.run(this, fn);
  }

  later(fn: () => void): void {
    if (this.frozen) this.held.push(fn);
    else fn();
  }

  freeze(): void {
    this.run(() => this.on?.suspend());
    this.frozen = true;
  }

  resume(): void {
    this.frozen = false;
    const held = this.held;
    this.held = [];
    for (const fn of held) fn();
    this.run(() => this.on?.resume());
  }
}

type Listener = (ev: { data: unknown }) => void;
const channels = new Map<string, Set<PageChannel>>();

/** In-process BroadcastChannel that holds what a frozen page sends and receives. */
class PageChannel {
  onmessage: Listener | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly page = pages.getStore();
  private closed = false;

  constructor(readonly name: string) {
    let set = channels.get(name);
    if (!set) channels.set(name, (set = new Set()));
    set.add(this);
  }

  postMessage(data: unknown): void {
    if (this.closed) return;
    const send = () => {
      for (const to of channels.get(this.name) ?? []) {
        if (to === this) continue;
        const copy = structuredClone(data);
        setImmediate(() => to.receive(copy));
      }
    };
    if (this.page) this.page.later(send);
    else send();
  }

  private receive(data: unknown): void {
    const deliver = () => {
      if (this.closed) return;
      this.onmessage?.({ data });
      for (const l of this.listeners) l({ data });
    };
    if (this.page) this.page.later(deliver);
    else deliver();
  }

  addEventListener(_: "message", l: Listener): void {
    this.listeners.add(l);
  }

  removeEventListener(_: "message", l: Listener): void {
    this.listeners.delete(l);
  }

  close(): void {
    this.closed = true;
    channels.get(this.name)?.delete(this);
  }
}

const g = globalThis as { BroadcastChannel?: unknown };
const RealChannel = g.BroadcastChannel;
beforeEach(() => {
  g.BroadcastChannel = PageChannel;
});
afterEach(() => {
  g.BroadcastChannel = RealChannel;
  channels.clear();
});

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish in ${ms} ms`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

async function stateOf(db: Db): Promise<{ head: number; rows: string[] }> {
  return db.view(async (snap) => {
    const rows: string[] = [];
    for await (const e of snap.range()) rows.push(`${dec.decode(e.key)}=${dec.decode(e.value)}`);
    return { head: snap.walHead, rows };
  });
}

async function twoTabs() {
  const fs = new MemoryFs();
  const host = new EngineHost(() => fs);
  const name = `lifecycle-${Math.random().toString(36).slice(2)}`;
  const page = new Page();
  const a = await page.run(() =>
    openHarnessDb({ name, fs, ingest: createLocalIngestClient(host), lifecycle: page.lifecycle }),
  );
  const b = await openHarnessDb({ name, fs, ingest: createLocalIngestClient(host) });
  return { page, a, b };
}

describe("a frozen or back/forward-cached tab", () => {
  it("does not stall the other tabs, and sees every acked write once it resumes", async () => {
    const { page, a, b } = await twoTabs();
    try {
      await a.put(utf("a1"), utf("1"));
      await b.put(utf("b1"), utf("1"));
      await a.sync();
      page.freeze();

      expect(str(await a.get(utf("a1"))), "a frozen tab still reads its own writes").toBe("1");
      await within(b.sync(), 2_000, "the other tab's sync");
      expect(str(await b.get(utf("a1")))).toBe("1");
      await within(
        b.update([utf("n")], ([n], tx) => tx.put(utf("n"), utf(String(Number(str(n) ?? "0") + 1)))),
        2_000,
        "the other tab's update",
      );
      await b.put(utf("b2"), utf("2"));

      page.resume();
      await within(a.sync(), 2_000, "the resumed tab's sync");
      expect(str(await a.get(utf("b2")))).toBe("2");
      expect(str(await a.get(utf("n")))).toBe("1");

      await a.put(utf("a2"), utf("2"));
      await within(a.update([utf("n")], ([n], tx) => tx.put(utf("n"), utf(String(Number(str(n)) + 1)))), 2_000, "an update after resume");
      await b.sync();
      await a.sync();
      const [sa, sb] = [await stateOf(a), await stateOf(b)];
      expect(sa).toEqual(sb);
      expect(sa.rows).toEqual(["a1=1", "a2=2", "b1=1", "b2=2", "n=2"]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("holds a write made while frozen until it resumes, then orders it after what it saw", async () => {
    const { page, a, b } = await twoTabs();
    try {
      await a.put(utf("k"), utf("a"));
      page.freeze();
      let landed = false;
      const write = a.put(utf("k"), utf("a-frozen")).then(() => (landed = true));
      await within(b.sync(), 2_000, "the other tab's sync");
      expect(str(await b.get(utf("k")))).toBe("a");
      await b.put(utf("k"), utf("b"));
      expect(landed, "a write waits for the tab to come back").toBe(false);

      page.resume();
      await within(write, 2_000, "the write made while frozen");
      expect(str(await a.get(utf("k")))).toBe("a-frozen");
      await within(b.sync(), 2_000, "the other tab's sync after resume");
      await a.sync();
      expect(str(await b.get(utf("k")))).toBe("a-frozen");
      expect(await stateOf(a)).toEqual(await stateOf(b));
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("can freeze and resume again, and close while frozen", async () => {
    const { page, a, b } = await twoTabs();
    try {
      for (let i = 0; i < 3; i++) {
        await a.put(utf(`a${i}`), utf("1"));
        page.freeze();
        await b.put(utf(`b${i}`), utf("1"));
        await within(b.sync(), 2_000, `the other tab's sync, round ${i}`);
        expect(str(await b.get(utf(`a${i}`)))).toBe("1");
        page.resume();
        await within(a.sync(), 2_000, `the resumed tab's sync, round ${i}`);
      }
      page.freeze();
      await within(a.close(), 2_000, "close while frozen");
      await b.put(utf("b3"), utf("1"));
      await within(b.sync(), 2_000, "the other tab's sync after the close");
      expect((await stateOf(b)).rows).toEqual(["a0=1", "a1=1", "a2=1", "b0=1", "b1=1", "b2=1", "b3=1"]);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
