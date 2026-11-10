/**
 * Every (own record, runs) pair for one key, on real pages: a page reads its
 * own records the installed manifest does not cover on top of the runs, a
 * tombstone included, in `get`, `range` and `view`, while another page
 * reads the runs alone.
 *
 * Run: pnpm --filter @opfs-lsm/kv formal:own-over-runs
 */
import { MemoryFs } from "../../src/index.js";
import { Host, openHarnessDb } from "../../src/testing.js";

type Kind = "none" | "tomb" | "A" | "B";
const KINDS: Kind[] = ["none", "tomb", "A", "B"];
const enc = new TextEncoder();
const dec = new TextDecoder();
const KEY = enc.encode("k");
const value = (kind: Kind) => (kind === "A" || kind === "B" ? kind : undefined);
const str = (v: Uint8Array | undefined) => (v ? dec.decode(v) : undefined);

let pairs = 0;
for (const runs of KINDS) {
  for (const own of KINDS) {
    pairs++;
    const fs = new MemoryFs();
    // Rounds run only when a page asks, so the reader's record stays its own.
    const host = new Host(() => fs, { maxLatencyMs: 1e9 });
    const other = await openHarnessDb({ name: "own-over-runs", fs, host });
    if (runs !== "none") {
      await other.put(KEY, enc.encode(runs === "tomb" ? "Z" : runs));
      await other.ingest();
      if (runs === "tomb") {
        await other.delete(KEY);
        await other.ingest();
      }
    }
    const reader = await openHarnessDb({ name: "own-over-runs", fs, host });
    if (own === "tomb") await reader.delete(KEY);
    else if (own !== "none") await reader.put(KEY, enc.encode(own));

    const want = own === "none" ? value(runs) : value(own);
    const got = {
      get: str(await reader.get(KEY)),
      range: await (async () => {
        const out: string[] = [];
        for await (const e of reader.range()) out.push(`${dec.decode(e.key)}=${dec.decode(e.value)}`);
        return out.join() || undefined;
      })(),
      view: await reader.view(async (snap) => str(await snap.get(KEY))),
      runsOnly: str(await other.get(KEY)),
    };
    const wantRange = want === undefined ? undefined : `k=${want}`;
    if (got.get !== want || got.range !== wantRange || got.view !== want || got.runsOnly !== value(runs)) {
      console.error(`FAIL own=${own} runs=${runs}: ${JSON.stringify(got)}, want ${String(want)} and runs alone ${String(value(runs))}`);
      process.exit(1);
    }
    await reader.close();
    await other.close();
  }
}
console.log(`PASS OwnOverRuns: ${pairs} (own, runs) pairs, get, range and view on real pages`);
// The hosts' latency timers would keep the process alive.
process.exit(0);
