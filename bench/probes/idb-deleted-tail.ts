/**
 * How long IndexedDB takes to find the last key of a store whose rows were
 * just deleted, the state kv's WAL is in after a flush truncates it. Writes
 * `rows` records, deletes them with one range delete, then times each way
 * of finding the head from a fresh tab.
 *
 *   node bench/probes/idb-deleted-tail.ts [rows]
 */
import { createServer } from "node:http";
import { launchChrome } from "../driver/chrome.ts";

const rows = Number(process.argv[2] ?? 25_700);

const page = `<!doctype html><script>
const open = () => new Promise((res, rej) => { const r = indexedDB.open("probe", 1); r.onupgradeneeded = () => r.result.createObjectStore("wal"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
window.fillLive = async (n) => {
  const db = await open();
  for (let lo = 1; lo <= n; lo += 100) {
    const tx = db.transaction("wal", "readwrite"); const s = tx.objectStore("wal");
    for (let k = lo; k < lo + 100 && k <= n; k++) s.put(new Uint8Array(40).buffer, k);
    await done(tx);
  }
  db.close(); return n;
};
window.fill = async (n) => {
  const db = await open();
  for (let lo = 1; lo <= n; lo += 100) {
    const tx = db.transaction("wal", "readwrite"); const s = tx.objectStore("wal");
    for (let k = lo; k < lo + 100 && k <= n; k++) s.put(new Uint8Array(40).buffer, k);
    await done(tx);
  }
  const tx = db.transaction("wal", "readwrite"); tx.objectStore("wal").delete(IDBKeyRange.upperBound(n)); await done(tx);
  db.close(); return n;
};
window.live = async (n, m) => {
  const db = await open(); const tx = db.transaction("wal", "readwrite"); const s = tx.objectStore("wal");
  for (let k = n + 1; k <= n + m; k++) s.put(new Uint8Array(40).buffer, k);
  await done(tx); db.close(); return m;
};
window.time = async (n) => {
  const db = await open(); const out = {};
  const ways = {
    "reverse cursor, unbounded": (s) => req(s.openKeyCursor(null, "prev")),
    "reverse cursor, lowerBound(ingested)": (s) => req(s.openKeyCursor(IDBKeyRange.lowerBound(n, true), "prev")),
    "getAllKeys(lowerBound(ingested))": (s) => req(s.getAllKeys(IDBKeyRange.lowerBound(n, true))),
    "forward cursor, lowerBound(ingested)": (s) => req(s.openKeyCursor(IDBKeyRange.lowerBound(n, true))),
    "count(lowerBound(ingested))": (s) => req(s.count(IDBKeyRange.lowerBound(n, true))),
  };
  for (const [name, way] of Object.entries(ways)) {
    const t0 = performance.now();
    const tx = db.transaction("wal", "readonly"); await way(tx.objectStore("wal")); await done(tx);
    out[name] = +(performance.now() - t0).toFixed(2);
  }
  db.close(); return out;
};
</script>`;

const server = createServer((_, res) => res.writeHead(200, { "content-type": "text/html" }).end(page));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
const chrome = await launchChrome({ headless: true, onProgress: () => {} });
try {
  if (process.env.LIVE) {
    const w = await chrome.openTab(origin);
    await w.evaluate(`window.fillLive(${rows})`, 300_000);
    await w.close();
    for (let i = 1; i <= 2; i++) {
      const t = await chrome.openTab(origin);
      console.log(`fresh tab, ${rows} live rows, nothing deleted, lookups from 0:`, await t.evaluate(`window.time(0)`, 60_000));
      await t.close();
    }
    process.exit(0);
  }
  const writer = await chrome.openTab(origin);
  await writer.evaluate(`window.fill(${rows})`, 300_000);
  console.log(`${rows} rows written and deleted. Head lookups, ms:`);
  console.log("same tab, right after the delete:", await writer.evaluate(`window.time(${rows})`, 60_000));
  await writer.close();
  for (let i = 1; i <= 3; i++) {
    const tab = await chrome.openTab(origin);
    console.log(`fresh tab ${i}:`, await tab.evaluate(`window.time(${rows})`, 60_000));
    await tab.close();
  }
  const tab = await chrome.openTab(origin);
  await tab.evaluate(`window.live(${rows}, 10)`, 60_000);
  await tab.close();
  const after = await chrome.openTab(origin);
  console.log("fresh tab, 10 live rows above the deleted ones:", await after.evaluate(`window.time(${rows})`, 60_000));
  await after.close();
} finally {
  await chrome.close();
  server.close();
}
