/**
 * How long IndexedDB takes to find the WAL head in the states kv's WAL store
 * is in, timed from fresh tabs. A flush keeps the records it folded and
 * deletes the ones the previous flush folded (`advanceIngested`), so right
 * after a flush the store holds thousands of just-deleted rows, then the
 * last flush's rows at or below `ingestedThrough`, then nothing.
 *
 *   node bench/probes/idb-deleted-tail.ts [rows] [kept] [rounds]
 *
 * `rows` records are written, all but the last `kept` are deleted, and
 * `ingestedThrough` is `rows`. Then 10 and 3,000 new records go above it.
 * Last, a store that never deleted a row holds `rows` records, 300 of them
 * past `ingestedThrough`. Each round is a fresh tab that runs every lookup
 * once, in a rotated order, each in its own transaction after one `get`, as
 * kv reads `meta` before the head. Every lookup must return the head.
 */
import { readdirSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { launchChrome } from "../driver/chrome.ts";

const rows = Number(process.argv[2] ?? 25_700);
const kept = Number(process.argv[3] ?? 1_000);
const rounds = Number(process.argv[4] ?? 9);

const page = `<!doctype html><script>
const open = (name) => new Promise((res, rej) => { const r = indexedDB.open(name, 1); r.onupgradeneeded = () => r.result.createObjectStore("wal"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
window.put = async (name, from, to) => {
  const db = await open(name);
  for (let lo = from; lo <= to; lo += 100) {
    const tx = db.transaction("wal", "readwrite"); const s = tx.objectStore("wal");
    for (let k = lo; k < lo + 100 && k <= to; k++) s.put(new Uint8Array(40).buffer, k);
    await done(tx);
  }
  db.close();
};
window.drop = async (name, through) => {
  const db = await open(name); const tx = db.transaction("wal", "readwrite");
  tx.objectStore("wal").delete(IDBKeyRange.upperBound(through)); await done(tx); db.close();
};
// Each way returns the head: the last key past ingestedThrough x, else x.
// \`a\` is the appliedThrough of a tab that is caught up, which is the head.
const last = async (s, x) => (await req(s.openKeyCursor(IDBKeyRange.lowerBound(x, true), "prev")))?.key ?? x;
const ways = {
  "reverse cursor, unbounded": async (s, x) => Math.max((await req(s.openKeyCursor(null, "prev")))?.key ?? 0, x),
  "forward cursor, then reverse (main)": async (s, x) => (await req(s.openKeyCursor(IDBKeyRange.lowerBound(x, true)))) ? last(s, x) : x,
  "getKey(range), then reverse": async (s, x) => (await req(s.getKey(IDBKeyRange.lowerBound(x, true)))) !== undefined ? last(s, x) : x,
  "getAllKeys(range, 1), then reverse": async (s, x) => (await req(s.getAllKeys(IDBKeyRange.lowerBound(x, true), 1))).length ? last(s, x) : x,
  "upper-bounded cursor, then reverse": async (s, x) => (await req(s.openKeyCursor(IDBKeyRange.bound(x, Number.MAX_SAFE_INTEGER, true)))) ? last(s, x) : x,
  "count(range)": async (s, x) => x + (await req(s.count(IDBKeyRange.lowerBound(x, true)))),
  "getKey(x + 1), then reverse": async (s, x) => (await req(s.getKey(x + 1))) !== undefined ? last(s, x) : x,
  "getKey(x + 1), then count": async (s, x) => (await req(s.getKey(x + 1))) !== undefined ? x + (await req(s.count(IDBKeyRange.lowerBound(x, true)))) : x,
  "forward cursor from appliedThrough 0 (open)": async (s, x) => (await req(s.openKeyCursor(IDBKeyRange.lowerBound(0, true)))) ? Math.max(x, (await req(s.openKeyCursor(null, "prev"))).key) : x,
  "getKey(a + 1), caught-up tab": async (s, x, a) => (await req(s.getKey(a + 1))) === undefined ? a : last(s, x),
};
window.time = async (name, x, head, round) => {
  const db = await open(name); const out = {};
  const names = Object.keys(ways);
  for (let i = 0; i < names.length; i++) {
    const label = names[(i + round) % names.length];
    const tx = db.transaction("wal", "readonly"); const s = tx.objectStore("wal");
    await req(s.get(-1));
    const t0 = performance.now();
    const got = await ways[label](s, x, head);
    out[label] = { ms: performance.now() - t0, ok: got === head };
    await done(tx);
  }
  db.close(); return out;
};
</script>`;

const headers = {
  "content-type": "text/html",
  // Cross-origin isolation gives performance.now() 5 µs steps instead of 100 µs.
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
};
const server = createServer((_, res) => res.writeHead(200, headers).end(page));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
const chrome = await launchChrome({ headless: true, onProgress: () => {} });
type Times = Record<string, { ms: number; ok: boolean }>;
try {
  const inTab = async <T>(expression: string): Promise<T> => {
    const tab = await chrome.openTab(origin);
    try {
      return await tab.evaluate<T>(expression, 300_000);
    } finally {
      await tab.close();
    }
  };
  const fmt = (ms: number) => ms.toFixed(2).padStart(6);
  const report = async (label: string, name: string, ingested: number, head: number) => {
    const runs: Times[] = [];
    for (let r = 0; r < rounds; r++) runs.push(await inTab<Times>(`window.time("${name}", ${ingested}, ${head}, ${r})`));
    console.log(`\n${label}. ms per lookup, ${rounds} fresh tabs: median (min to max)`);
    for (const way of Object.keys(runs[0]!)) {
      const ms = runs.map((run) => run[way]!.ms).sort((a, b) => a - b);
      const wrong = runs.filter((run) => !run[way]!.ok).length;
      const median = ms[Math.floor(ms.length / 2)]!;
      console.log(`  ${way.padEnd(44)} ${fmt(median)} (${fmt(ms[0]!)} to ${fmt(ms.at(-1)!)})${wrong ? `  WRONG HEAD in ${wrong}` : ""}`);
    }
  };

  await inTab(`window.put("flushed", 1, ${rows})`);
  await inTab(`window.drop("flushed", ${rows - kept})`);
  console.log(`${rows} records written, the oldest ${rows - kept} deleted, ingestedThrough ${rows}.`);
  await report("Right after a flush, empty tail", "flushed", rows, rows);
  await inTab(`window.put("flushed", ${rows + 1}, ${rows + 10})`);
  await report("10 records above ingestedThrough", "flushed", rows, rows + 10);
  await inTab(`window.put("flushed", ${rows + 11}, ${rows + 3000})`);
  await report("3,000 records above ingestedThrough", "flushed", rows, rows + 3000);

  await inTab(`window.put("clean", 1, ${rows})`);
  await report(`No row ever deleted, ${rows} records, 300 past ingestedThrough`, "clean", rows - 300, rows);

  const idb = path.join(chrome.profile, "Default", "IndexedDB");
  console.log(`\nIndexedDB backend files: ${readdirSync(idb).join(", ")}`);
} finally {
  await chrome.close();
  server.close();
}
