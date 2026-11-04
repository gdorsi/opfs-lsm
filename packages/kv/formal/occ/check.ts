/**
 * Exhaustive OCC: commit conflicts iff a WAL record after snapshotHead
 * touches a key the txn read or wrote. Mirrors the guarded IdBWal.append in idb/wal.ts.
 *
 * Sync: requires the ConflictError path still present in idb/wal.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEYS = ["a", "b"] as const;
type Key = (typeof KEYS)[number];

type WalRec = { seq: number; keys: readonly Key[] };

type Tx = {
  snapshotHead: number;
  reads: ReadonlySet<Key>;
  writes: ReadonlySet<Key>;
};

type State = {
  nextSeq: number;
  wal: readonly WalRec[];
  /** Open txn, or null. */
  tx: Tx | null;
  /** Outcome of last commit attempt. */
  last: "none" | "ok" | "conflict";
};

type Action =
  | { type: "openTx" }
  | { type: "txRead"; key: Key }
  | { type: "txWrite"; key: Key }
  | { type: "concurrentAppend"; key: Key }
  | { type: "commit" };

function initial(): State {
  return { nextSeq: 1, wal: [], tx: null, last: "none" };
}

function watched(tx: Tx): Set<Key> {
  return new Set([...tx.reads, ...tx.writes]);
}

/** Spec: conflict iff some wal seq > snapshotHead shares a watched key. */
function wouldConflict(s: State, tx: Tx): boolean {
  const w = watched(tx);
  for (const r of s.wal) {
    if (r.seq <= tx.snapshotHead) continue;
    for (const k of r.keys) if (w.has(k)) return true;
  }
  return false;
}

/**
 * Whether product code still performs the OCC check.
 * Broken scratch: remove ConflictError throw from commit.
 */
function occCheckPresentInSource(): boolean {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(
    path.resolve(here, "../../src/idb/wal.ts"),
    "utf8",
  );
  return (
    /throw\s+new\s+ConflictError/.test(src) &&
    /lowerBound\(guard\.snapshotHead,\s*true\)/.test(src) &&
    /watched\.has/.test(src)
  );
}

function enabled(s: State): Action[] {
  const out: Action[] = [];
  if (!s.tx) {
    out.push({ type: "openTx" });
    for (const key of KEYS) out.push({ type: "concurrentAppend", key });
  } else {
    for (const key of KEYS) {
      out.push({ type: "txRead", key });
      out.push({ type: "txWrite", key });
      out.push({ type: "concurrentAppend", key });
    }
    if (s.tx.writes.size > 0 || s.tx.reads.size > 0) {
      out.push({ type: "commit" });
    }
  }
  return out;
}

function step(s: State, a: Action): State {
  switch (a.type) {
    case "openTx": {
      const head = s.nextSeq - 1;
      return {
        ...s,
        tx: {
          snapshotHead: head,
          reads: new Set(),
          writes: new Set(),
        },
        last: "none",
      };
    }
    case "txRead": {
      if (!s.tx) return s;
      const reads = new Set(s.tx.reads);
      reads.add(a.key);
      return { ...s, tx: { ...s.tx, reads } };
    }
    case "txWrite": {
      if (!s.tx) return s;
      const writes = new Set(s.tx.writes);
      writes.add(a.key);
      return { ...s, tx: { ...s.tx, writes } };
    }
    case "concurrentAppend": {
      const rec: WalRec = { seq: s.nextSeq, keys: [a.key] };
      return {
        ...s,
        wal: [...s.wal, rec],
        nextSeq: s.nextSeq + 1,
      };
    }
    case "commit": {
      if (!s.tx) return s;
      // Empty write set: real commit returns early without conflict check.
      if (s.tx.writes.size === 0) {
        return { ...s, tx: null, last: "ok" };
      }
      if (!occCheckPresentInSource()) {
        // Model of broken code: always append writes.
        const rec: WalRec = {
          seq: s.nextSeq,
          keys: [...s.tx.writes],
        };
        return {
          ...s,
          wal: [...s.wal, rec],
          nextSeq: s.nextSeq + 1,
          tx: null,
          last: "ok",
        };
      }
      if (wouldConflict(s, s.tx)) {
        return { ...s, tx: null, last: "conflict" };
      }
      const rec: WalRec = {
        seq: s.nextSeq,
        keys: [...s.tx.writes],
      };
      return {
        ...s,
        wal: [...s.wal, rec],
        nextSeq: s.nextSeq + 1,
        tx: null,
        last: "ok",
      };
    }
    default: {
      const _e: never = a;
      return _e;
    }
  }
}

/** Safety: successful commit never overlapped; conflict only when overlapped (with writes). */
function safe(s: State, prev: State, a: Action): boolean {
  if (a.type !== "commit" || !prev.tx) return true;
  if (prev.tx.writes.size === 0) return s.last === "ok";
  const conflict = wouldConflict(prev, prev.tx);
  if (s.last === "ok" && conflict) return false;
  if (s.last === "conflict" && !conflict) return false;
  return true;
}

function enc(s: State): string {
  return JSON.stringify({
    nextSeq: s.nextSeq,
    wal: s.wal,
    last: s.last,
    tx: s.tx
      ? {
          snapshotHead: s.tx.snapshotHead,
          reads: [...s.tx.reads].sort(),
          writes: [...s.tx.writes].sort(),
        }
      : null,
  });
}

function label(a: Action): string {
  switch (a.type) {
    case "openTx":
      return "openTx(headSeq)";
    case "txRead":
      return `tx.get(${a.key})`;
    case "txWrite":
      return `tx.put(${a.key})`;
    case "concurrentAppend":
      return `concurrent WAL append(${a.key})`;
    case "commit":
      return "tx.commit";
    default: {
      const _e: never = a;
      return _e;
    }
  }
}

type Node = { state: State; prev: number; action: Action | null };

const MAX_STEPS = 8;
const nodes: Node[] = [{ state: initial(), prev: -1, action: null }];
const seen = new Map<string, number>([[enc(initial()), 0]]);
let states = 1;

for (let i = 0; i < nodes.length; i++) {
  const cur = nodes[i]!;
  const depth = (() => {
    let d = 0;
    let j = i;
    while (nodes[j]!.prev >= 0) {
      d++;
      j = nodes[j]!.prev;
    }
    return d;
  })();
  if (depth >= MAX_STEPS) continue;

  for (const a of enabled(cur.state)) {
    const next = step(cur.state, a);
    if (!safe(next, cur.state, a)) {
      const path: string[] = [];
      let j: number | null = i;
      while (j !== null && j >= 0) {
        const n = nodes[j]!;
        if (n.action) path.push(label(n.action));
        j = n.prev >= 0 ? n.prev : null;
      }
      path.reverse();
      path.push(label(a));
      console.error("FAIL OccSafety");
      console.error(
        `commit outcome=${next.last} but conflict=${wouldConflict(cur.state, cur.state.tx!)}`,
      );
      console.error("shortest path:");
      path.forEach((l, idx) => console.error(`  ${idx + 1}. ${l}`));
      console.error(
        "\nHarm: two transactions silently overwrite the same key, or a false ConflictError aborts a safe commit.",
      );
      process.exit(1);
    }
    const key = enc(next);
    if (seen.has(key)) continue;
    seen.set(key, nodes.length);
    nodes.push({ state: next, prev: i, action: a });
    states++;
  }
}

if (!occCheckPresentInSource()) {
  console.error(
    "FAIL OccSafety — idb/wal.ts no longer has the OCC ConflictError check",
  );
  process.exit(1);
}

console.log(
  `PASS OccSafety — ${states} states, ConflictError check present in idb/wal.ts`,
);
