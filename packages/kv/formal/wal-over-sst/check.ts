/**
 * Every (WAL hit, SST hit) pair: resolveGet prefers WAL (incl. tombstones).
 * Runs against the real KeyOverlay + resolveGet.
 */
import { KeyOverlay, resolveGet } from "../../src/store/overlay.js";

type Kind = "miss" | "tomb" | "valueA" | "valueB";

const KEY = new Uint8Array([1]);
const A = new Uint8Array([10]);
const B = new Uint8Array([20]);

function layer(kind: Kind): KeyOverlay {
  const o = new KeyOverlay();
  if (kind === "tomb") {
    o.applyOps([{ type: "del", key: KEY as never }]);
  } else if (kind === "valueA") {
    o.applyOps([{ type: "put", key: KEY as never, value: A as never }]);
  } else if (kind === "valueB") {
    o.applyOps([{ type: "put", key: KEY as never, value: B as never }]);
  }
  return o;
}

function expected(wal: Kind, sst: Kind): Uint8Array | undefined {
  if (wal === "tomb") return undefined;
  if (wal === "valueA") return A;
  if (wal === "valueB") return B;
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
for (const wal of KINDS) {
  for (const sst of KINDS) {
    n++;
    const got = resolveGet(KEY, layer(wal), layer(sst));
    const want = expected(wal, sst);
    if (!eq(got, want)) {
      console.error(
        `FAIL wal=${wal} sst=${sst} got=${got ? [...got] : "undef"} want=${want ? [...want] : "undef"}`,
      );
      process.exit(1);
    }
  }
}
console.log(`PASS WalOverSst — ${n} pairs on real resolveGet`);
