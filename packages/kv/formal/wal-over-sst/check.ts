/**
 * Every (mem hit, SST hit) pair: pointGet prefers the mem row (incl. tombstones).
 * Runs against the real pointGet over a one-run level.
 */
import { encodeSst, sstKeyRange } from "../../src/store/sst.js";
import { pointGet, runLevels, type RunLevel } from "../../src/store/merge.js";
import { untilHit } from "../../src/store/cursor.js";
import { PageCache } from "../../src/store/page-cache.js";
import { bytesFile, SstReader } from "../../src/store/sst-reader.js";
import type { MemRow } from "../../src/store/memtable.js";

type Kind = "miss" | "tomb" | "valueA" | "valueB";

const KEY = new Uint8Array([1]);
const A = new Uint8Array([10]);
const B = new Uint8Array([20]);

function memRow(kind: Kind): MemRow | undefined {
  if (kind === "miss") return undefined;
  if (kind === "tomb") return { key: KEY, seq: 1, kind: "del" };
  return {
    key: KEY,
    seq: 1,
    kind: "put",
    value: kind === "valueA" ? A : B,
  };
}

function readers(kind: Kind): RunLevel[] {
  if (kind === "miss") return [];
  const entry =
    kind === "tomb"
      ? { kind: "del" as const, key: KEY }
      : {
          kind: "put" as const,
          key: KEY,
          value: kind === "valueA" ? A : B,
        };
  const body = encodeSst([entry]);
  return runLevels(["l0/1-1.sst"], [new SstReader(bytesFile(body), new PageCache(), sstKeyRange(body))]);
}

function expected(mem: Kind, sst: Kind): Uint8Array | undefined {
  if (mem === "tomb") return undefined;
  if (mem === "valueA") return A;
  if (mem === "valueB") return B;
  if (sst === "tomb") return undefined;
  if (sst === "valueA") return A;
  if (sst === "valueB") return B;
  return undefined;
}

function eq(
  a: Uint8Array | undefined,
  b: Uint8Array | undefined,
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

const KINDS: Kind[] = ["miss", "tomb", "valueA", "valueB"];
let n = 0;
for (const mem of KINDS) {
  for (const sst of KINDS) {
    n++;
    const levels = readers(sst);
    const got = await untilHit(() => pointGet(memRow(mem), levels, KEY));
    const want = expected(mem, sst);
    if (!eq(got, want)) {
      console.error(
        `FAIL mem=${mem} sst=${sst} got=${got ? [...got] : "undef"} want=${want ? [...want] : "undef"}`,
      );
      process.exit(1);
    }
  }
}
console.log(`PASS WalOverSst — ${n} pairs on real pointGet`);
