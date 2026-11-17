/**
 * How long IndexedDB takes to find the WAL head in the states kv's WAL store
 * is in, timed from a fresh tab. A flush keeps the records it folded and
 * deletes the ones the previous flush folded (`advanceIngested`), so right
 * after a flush the store holds thousands of just-deleted rows, then the
 * last flush's rows at or below `ingestedThrough`, then nothing.
 *
 *   node bench/probes/idb-deleted-tail.ts [rows] [kept]
 *
 * `rows` records are written, all but the last `kept` are deleted, and
 * `ingestedThrough` is `rows`. Then the lookups run again with 10 new
 * records above it, and on a store that never deleted anything.
 */
import { createServer } from "node:http";
import { launchChrome } from "../driver/chrome.ts";

const rows = Number(process.argv[2] ?? 25_700);
const kept = Number(process.argv[3] ?? 1_000);

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
window.time = async (name, ingested) => {
  const db = await open(name); const out = {};
  const past = IDBKeyRange.lowerBound(ingested, true);
  const ways = {
    "reverse cursor (before #294)": (s) => req(s.openKeyCursor(null, "prev")),
    "forward first (#294)": async (s) => (await req(s.openKeyCursor(past))) ? req(s.openKeyCursor(past, "prev")) : null,
  };
  for (const [label, way] of Object.entries(ways)) {
    const t0 = performance.now();
    const tx = db.transaction("wal", "readonly"); await way(tx.objectStore("wal")); await done(tx);
    out[label] = +(performance.now() - t0).toFixed(2);
  }
  db.close(); return out;
};
</script>`;

const server = createServer((_, res) => res.writeHead(200, { "content-type": "text/html" }).end(page));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
const chrome = await launchChrome({ headless: true, onProgress: () => {} });
try {
  const inTab = async <T>(expression: string): Promise<T> => {
    const tab = await chrome.openTab(origin);
    try {
      return await tab.evaluate<T>(expression, 300_000);
    } finally {
      await tab.close();
    }
  };
  const report = async (label: string, name: string, ingested: number) => {
    for (let i = 1; i <= 3; i++) console.log(`${label}, fresh tab ${i}:`, await inTab(`window.time("${name}", ${ingested})`));
  };

  await inTab(`window.put("flushed", 1, ${rows})`);
  await inTab(`window.drop("flushed", ${rows - kept})`);
  console.log(`Head lookups, ms. ${rows} records written, the oldest ${rows - kept} deleted, ingestedThrough ${rows}.`);
  await report("right after a flush, empty tail", "flushed", rows);
  await inTab(`window.put("flushed", ${rows + 1}, ${rows + 10})`);
  await report("then 10 new records above ingestedThrough", "flushed", rows);

  await inTab(`window.put("clean", 1, ${rows})`);
  await report(`no row ever deleted, ${rows} records past ingestedThrough 0`, "clean", 0);
} finally {
  await chrome.close();
  server.close();
}
