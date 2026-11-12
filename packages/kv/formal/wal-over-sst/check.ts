/**
 * Every (mem hit, SST hit, mark, time) case: pointGet prefers the mem row
 * (incl. tombstones and expired puts), an SST version a range delete covers
 * reads as absent, and a newest version expired at the read's time reads as
 * absent and hides the SST one. Runs against the real pointGet over a
 * one-run level.
 */
import { encodeSst, sstKeyRange } from "../../src/store/sst.js";
import { pointGet, runLevels, type RunLevel } from "../../src/store/read.js";
import { untilHit } from "../../src/store/cursor.js";
import { PageCache } from "../../src/store/page-cache.js";
import { bytesFile, SstReader } from "../../src/store/sst-reader.js";
import type { MemRow } from "../../src/store/memtable.js";
import { markTable, NO_MARKS, type Marks } from "../../src/store/marks.js";

/** `expiring` is value B with an expiry at `EXPIRES_AT`. */
type Kind = "miss" | "tomb" | "valueA" | "valueB" | "expiring";
/** No range delete, one that covers the SST version, one that stops just below it. */
type Mark = "none" | "covers" | "spares";

const SST_SEQ = 2;
const MEM_SEQ = 4;
const EXPIRES_AT = 5;
/** Just before the deadline, and at it. */
const TIMES = [EXPIRES_AT - 1, EXPIRES_AT];

const KEY = new Uint8Array([1]);
const A = new Uint8Array([10]);
const B = new Uint8Array([20]);

function memRow(kind: Kind): MemRow | undefined {
  if (kind === "miss") return undefined;
  if (kind === "tomb") return { key: KEY, seq: MEM_SEQ, kind: "del" };
  return {
    key: KEY,
    seq: MEM_SEQ,
    kind: "put",
    value: kind === "valueA" ? A : B,
    ...(kind === "expiring" ? { expiresAt: EXPIRES_AT } : {}),
  };
}

function readers(kind: Kind): RunLevel[] {
  if (kind === "miss") return [];
  const entry =
    kind === "tomb"
      ? { kind: "del" as const, key: KEY, seq: SST_SEQ }
      : {
          kind: "put" as const,
          key: KEY,
          value: kind === "valueA" ? A : B,
          seq: SST_SEQ,
          ...(kind === "expiring" ? { expiresAt: EXPIRES_AT } : {}),
        };
  const body = encodeSst([entry]);
  return runLevels(["l0/1-1.sst"], [new SstReader(bytesFile(body), new PageCache(), sstKeyRange(body))]);
}

function marks(mark: Mark): Marks {
  if (mark === "none") return NO_MARKS;
  const through = mark === "covers" ? SST_SEQ : SST_SEQ - 1;
  return markTable({ start: new Uint8Array(0), endExclusive: new Uint8Array([2]), through, at: SST_SEQ + 1 });
}

function expected(mem: Kind, sst: Kind, mark: Mark, now: number): Uint8Array | undefined {
  if (mem === "tomb") return undefined;
  if (mem === "valueA") return A;
  if (mem === "valueB") return B;
  if (mem === "expiring") return now < EXPIRES_AT ? B : undefined;
  if (mark === "covers") return undefined;
  if (sst === "tomb") return undefined;
  if (sst === "valueA") return A;
  if (sst === "valueB") return B;
  if (sst === "expiring") return now < EXPIRES_AT ? B : undefined;
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

const KINDS: Kind[] = ["miss", "tomb", "valueA", "valueB", "expiring"];
const MARKS: Mark[] = ["none", "covers", "spares"];
let n = 0;
for (const mem of KINDS) {
  for (const sst of KINDS) {
    for (const mark of MARKS) {
      for (const now of TIMES) {
        n++;
        const levels = readers(sst);
        const at = { now, marks: marks(mark) };
        const got = await untilHit(() => pointGet(memRow(mem), levels, KEY, at));
        const want = expected(mem, sst, mark, now);
        if (!eq(got, want)) {
          console.error(
            `FAIL mem=${mem} sst=${sst} mark=${mark} now=${now} got=${got ? [...got] : "undef"} want=${want ? [...want] : "undef"}`,
          );
          process.exit(1);
        }
      }
    }
  }
}
console.log(`PASS WalOverSst — ${n} cases (mem, SST, mark, time) on real pointGet`);
