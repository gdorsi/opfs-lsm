/**
 * Every (mem hit, SST hit) pair: pointGet prefers the mem row (incl. tombstones).
 * Runs against the real pointGet + SstReader.
 */
import { encodeSst, SstReader } from "../../src/store/sst.js";
import { pointGet } from "../../src/store/merge.js";
import type { MemRow } from "../../src/idb/wal.js";

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

function readers(kind: Kind): SstReader[] {
  if (kind === "miss") return [];
  const entry =
    kind === "tomb"
      ? { kind: "del" as const, key: KEY }
      : {
          kind: "put" as const,
          key: KEY,
          value: kind === "valueA" ? A : B,
        };
  return [new SstReader(encodeSst([entry]))];
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
    const got = pointGet(memRow(mem), readers(sst), KEY);
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
