import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Db } from "@opfs-lsm/kv";
import { ingest, openHarnessDb } from "@opfs-lsm/kv/testing";
import * as Y from "yjs";
import { KvPersistence } from "../src/index.ts";

const RUNS = Number(process.env.YJS_MODEL_RUNS ?? 40);
// Names that share leading bytes, and one past 255 bytes, whose length takes two bytes of the key prefix.
const NAMES = ["", "a", "a\u0000", "a/b", "a" + "/".repeat(256)];

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Open = { readonly name: string; readonly doc: Y.Doc; readonly p: KvPersistence };

async function run(seed: number): Promise<void> {
  const rand = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  const name = `yjm${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const tabs = [
    await openHarnessDb({ name, forceMemory: true, writerId: "tab-a", maxWalBytes: 4096 }),
    await openHarnessDb({ name, forceMemory: true, writerId: "tab-b", maxWalBytes: 4096 }),
  ];
  let failing = false;
  const flaky = (db: Db): Db =>
    new Proxy(db, {
      get(target, key) {
        if ((key === "put" || key === "batch") && failing) return () => Promise.reject(new Error("disk full"));
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const model = new Map(NAMES.map((n) => [n, new Y.Doc()]));
  const open: Open[] = [];
  const trimSize = 1 + Math.floor(rand() * 6);
  const steps: string[] = [];
  try {
    for (let step = 0; step < 120; step++) {
      const op = rand();
      if (open.length === 0 || op < 0.12) {
        const docName = pick(NAMES);
        const doc = new Y.Doc();
        doc.on("update", (update: Uint8Array) => Y.applyUpdate(model.get(docName)!, update));
        const p = new KvPersistence(flaky(pick(tabs)), docName, doc, trimSize);
        p.trimDelayMs = Math.floor(rand() * 3);
        open.push({ name: docName, doc, p });
        const waits = rand() < 0.5;
        steps.push(`open ${JSON.stringify(docName)}${waits ? " and wait" : ""}`);
        if (waits) await p.whenSynced;
      } else if (op < 0.6) {
        const { name: docName, doc } = pick(open);
        const text = doc.getText("t");
        const kind = rand();
        if (kind < 0.5 || text.length === 0) {
          text.insert(Math.floor(rand() * (text.length + 1)), String.fromCharCode(97 + Math.floor(rand() * 26)));
        } else if (kind < 0.7) {
          text.delete(Math.floor(rand() * text.length), 1);
        } else if (kind < 0.85) {
          doc.getMap("m").set(`k${Math.floor(rand() * 4)}`, Math.floor(rand() * 100));
        } else {
          doc.getMap("m").delete(`k${Math.floor(rand() * 4)}`);
        }
        steps.push(`edit ${JSON.stringify(docName)}`);
      } else if (op < 0.7) {
        const { name: docName, p } = pick(open);
        steps.push(`flush ${JSON.stringify(docName)}`);
        await p.flush().catch(() => {});
      } else if (op < 0.78) {
        const { name: docName, doc, p } = open.splice(Math.floor(rand() * open.length), 1)[0]!;
        const viaDoc = rand() < 0.5;
        steps.push(`destroy ${JSON.stringify(docName)}${viaDoc ? " via the doc" : ""}`);
        // A destroy that rejects may lose the writes that failed, so it runs with writes working.
        failing = false;
        if (viaDoc) doc.destroy();
        await p.destroy();
      } else if (op < 0.82) {
        failing = !failing;
        steps.push(failing ? "writes fail" : "writes work");
      } else if (op < 0.85) {
        steps.push("sleep");
        await sleep(Math.floor(rand() * 4));
      } else if (op < 0.9) {
        steps.push("sync");
        await pick(tabs).sync();
      } else if (op < 0.93) {
        steps.push("ingest");
        await ingest(pick(tabs));
      } else {
        const a = pick(open);
        const b = open.find((other) => other !== a && other.name === a.name);
        if (b) {
          steps.push(`provider syncs ${JSON.stringify(a.name)}`);
          Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), "provider");
          Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), "provider");
        }
      }
    }
    failing = false;
    for (const { p } of open) await p.destroy();

    const fresh = await openHarnessDb({ name, forceMemory: true, writerId: "tab-c" });
    tabs.push(fresh);
    for (const docName of NAMES) {
      const doc = new Y.Doc();
      const p = new KvPersistence(fresh, docName, doc, 1_000_000);
      await p.whenSynced;
      const expected = model.get(docName)!;
      const at = `seed ${seed}, trimSize ${trimSize}, doc ${JSON.stringify(docName)}\n${steps.join("\n")}`;
      assert.equal(doc.getText("t").toString(), expected.getText("t").toString(), at);
      assert.deepEqual(doc.getMap("m").toJSON(), expected.getMap("m").toJSON(), at);
      assert.deepEqual(Y.decodeStateVector(Y.encodeStateVector(doc)), Y.decodeStateVector(Y.encodeStateVector(expected)), at);
      await p.destroy();
    }
  } finally {
    for (const tab of tabs) await tab.close();
  }
}

test("random edits, merges, failed writes and reopens in two tabs reload as one Y.Doc that saw every update", async () => {
  for (let seed = 1; seed <= RUNS; seed++) await run(seed);
});
