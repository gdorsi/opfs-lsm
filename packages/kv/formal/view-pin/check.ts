/**
 * Exhaustive check on real pages: a `view` reads the state it opened on.
 * Every sequence of up to three actions runs inside an open view: the
 * page's own put and delete, its ingest (the host ingests, compacts, and
 * the page installs the manifest), and another page's put and ingest
 * followed by this page's sync. After each one, the view's `get` and
 * `range` must read what they read when it opened, and once the view ends
 * a page that alone wrote must read its newest write.
 *
 * Run: pnpm --filter @opfs-lsm/kv formal:view-pin
 */
import type { Db } from "../../src/index.js";
import { MemoryFs } from "../../src/index.js";
import { Host, openHarnessDb } from "../../src/testing.js";

type Act = "put" | "del" | "ingest" | "other";
const ACTS: Act[] = ["put", "del", "ingest", "other"];
const MAX = 3;
const enc = new TextEncoder();
const dec = new TextDecoder();
const KEY = enc.encode("k");

function* sequences(n: number): Generator<Act[]> {
  if (n === 0) {
    yield [];
    return;
  }
  for (const head of sequences(n - 1)) for (const a of ACTS) yield [...head, a];
}

async function rangeOf(read: { range(): AsyncIterable<{ key: Uint8Array; value: Uint8Array }> }): Promise<string> {
  const out: string[] = [];
  for await (const e of read.range()) out.push(`${dec.decode(e.key)}=${dec.decode(e.value)}`);
  return out.join();
}

let runs = 0;
let reads = 0;
for (const before of [[], ...ACTS.map((a) => [a])] as Act[][]) {
  for (let n = 1; n <= MAX; n++) {
    for (const inside of sequences(n)) {
      runs++;
      const fs = new MemoryFs();
      const host = new Host(() => fs, { maxLatencyMs: 1e9 });
      const page = await openHarnessDb({ name: "view-pin", fs, host });
      const other = await openHarnessDb({ name: "view-pin", fs, host });
      let next = 1;
      let newest: string | undefined;
      const act = async (a: Act, db: Db) => {
        if (a === "put") await page.put(KEY, enc.encode((newest = `v${next++}`)));
        else if (a === "del") {
          newest = undefined;
          await page.delete(KEY);
        }
        else if (a === "ingest") await page.ingest();
        else {
          await other.put(KEY, enc.encode((newest = `o${next++}`)));
          await other.ingest();
          await db.sync();
        }
      };
      for (const a of before) await act(a, page);
      await page.view(async (snap) => {
        const atOpen = { get: (await snap.get(KEY)) && dec.decode((await snap.get(KEY))!), range: await rangeOf(snap) };
        for (const [i, a] of inside.entries()) {
          await act(a, page);
          const got = { get: (await snap.get(KEY)) && dec.decode((await snap.get(KEY))!), range: await rangeOf(snap) };
          reads++;
          if (got.get !== atOpen.get || got.range !== atOpen.range) {
            console.error(`FAIL ViewPin: before [${before}] then in the view [${inside.slice(0, i + 1)}]: read ${JSON.stringify(got)}, opened on ${JSON.stringify(atOpen)}`);
            process.exit(1);
          }
        }
      });
      // With another page's writes, the ingest order picks the winner: last writer wins.
      const after = await page.get(KEY);
      if (!before.includes("other") && !inside.includes("other") && (after && dec.decode(after)) !== newest) {
        console.error(`FAIL after the view, [${before}] then [${inside}]: page reads ${String(after && dec.decode(after))}, newest write ${String(newest)}`);
        process.exit(1);
      }
      await page.close();
      await other.close();
    }
  }
}
console.log(`PASS ViewPin: ${runs} action sequences, ${reads} view reads after an action, on real pages`);
// The hosts' latency timers would keep the process alive.
process.exit(0);
