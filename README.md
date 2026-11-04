# @opfs-lsm/kv

`@opfs-lsm/kv` is a key-value store for the browser. You open a database with `openDb`. The promise from `put` or `batch` is the ack. When that promise resolves, the write is durable.

## A SharedWorker publishes the sealed files

IndexedDB is the database the browser keeps for this site. This store uses it as a write-ahead log, called a WAL. The WAL is the ordered list of puts and deletes. One WAL exists per `openDb` name, and every tab that opened that name appends to it. IndexedDB assigns the sequence numbers.

OPFS is the Origin Private File System, a private set of files for this site. The sealed data lives there as SST files. An SST is a sorted string table, an immutable file of keys and values, sorted by key.

A SharedWorker publishes those SST files. A SharedWorker is one script that every tab of this origin can share. It is not a dedicated WebWorker, and it is not a ServiceWorker. Tabs append to the IndexedDB WAL and read both that WAL and the SST files. A get stays in the tab. The SharedWorker is not on that path.

## The ack is an IndexedDB commit

`put` and `batch` ack when the shared IndexedDB WAL commits. Another tab can read that write on its next get. Ingest publishes the committed rows to an OPFS SST. Ingest is not required for the ack. Until ingest runs, the rows are in IndexedDB and not yet in an SST.

```ts
import { openDb } from "@opfs-lsm/kv";

const db = await openDb({
  name: "notes",
  workerUrl: new URL("@opfs-lsm/kv/shared-worker", import.meta.url),
});

const key = new TextEncoder().encode("hello");
const value = new TextEncoder().encode("world");
await db.put(key, value);
const found = await db.get(key);
```

In the browser, `workerUrl` is the SharedWorker module. `new URL("@opfs-lsm/kv/shared-worker", import.meta.url)` is the URL this package exports.

## Batch and warm gets beat Dexie

Dexie is a library that stores rows in IndexedDB. The times below are wall time for 50 operations on one Chrome headless run. The host was darwin on 2026-11-03. The bench used the SharedWorker path and `BENCH_N=50`. Your machine will differ.

One batch of 50 puts took 0.4 ms. Dexie `bulkPut` of the same 50 took 1.2 ms.

50 warm gets took 1.4 ms. Those gets read keys just written, before ingest. 50 Dexie point gets took 3.1 ms.

50 post-ingest gets took 2.1 ms. Ingest had published the keys to an OPFS SST. That time was still under the Dexie point get.

## A solitary put stays near IndexedDB

50 solitary puts took 9.6 ms. 50 Dexie solitary puts took 9.2 ms. A solitary put stays near IDB, because each ack is one IndexedDB commit.

## Collections vs Dexie

`@opfs-lsm/collections` is tables and indexes on top of the same WAL and OPFS path. `pnpm bench:collections` runs the SharedWorker Chrome harness against a `users` table with an `email` index, then Dexie with `id, email`. Collections has no `bulkPut` yet, so the fair write comparison is solitary put. Each collections put also writes index keys in one OCC transaction, so it is heavier than a Dexie row put. Point get and `where("email", …)` are measured before and after ingest. The times below are median of 5 runs with `BENCH_N=50` on darwin.

Uningested rows live in a key-ordered IndexedDB memtable written in the same transaction as the WAL ack. Gets and prefix ranges read that store (and SST block cursors after ingest). There is no tab-local overlay cache of the WAL.

50 collections solitary puts took about 47 ms. 50 Dexie solitary puts took about 8.5 ms.

50 collections gets by id took 3.7 ms (median). 50 Dexie point gets took 3.0 ms.

50 collections `where("email", …)` took 11.5 ms (median). 50 Dexie `where("email").equals(…)` took 3.2 ms. Each collections where is one mem range cursor plus a point get.

50 post-ingest collections `where` took 15.3 ms (median).

```
pnpm bench:collections
BENCH_N=50 pnpm bench:collections
```

## Clone and run

`engines.node` in `package.json` is `>=22`. `.nvmrc` pins 24. `packageManager` is `pnpm@10.33.2`.

The wasm files are already in `packages/kv/wasm`. `pnpm test` typechecks with `tsc` and skips `wasm-pack` while `engine_wasm_bg.wasm` and `engine_wasm.js` are present. You need Rust and `wasm-pack` only when those files are missing.

`pnpm bench:browser` starts headless Chrome. On macOS the script uses `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. Otherwise it uses `google-chrome` on `PATH`. Set `CHROME_PATH` when Chrome is somewhere else. The plain command uses the SharedWorker. `BENCH_LOCAL=1` opens the page with `local=1` and uses the in-page engine. The times above used the SharedWorker.

```
git clone https://github.com/gdorsi/opfs-lsm.git
cd opfs-lsm
pnpm install
pnpm test
pnpm bench:browser
pnpm bench:collections
```
