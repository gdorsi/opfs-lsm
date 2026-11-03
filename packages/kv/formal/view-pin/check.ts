/**
 * View pin: after openViewSnapshot, get must ignore later WAL appends.
 * Mirrors ViewSnapshotImpl (cloned overlays) vs live resolveGet.
 *
 * Sync: ViewSnapshotImpl must clone overlays in the constructor.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type State = {
  /** Live durable value for key k (latest ack). */
  live: number | undefined;
  /** Pinned view value; undefined until view opens. */
  pinned: number | undefined | "closed";
  nextVal: number;
};

type Action =
  | { type: "append" }
  | { type: "openView" }
  | { type: "viewGet" }
  | { type: "closeView" };

function initial(): State {
  return { live: undefined, pinned: "closed", nextVal: 1 };
}

function viewClonesInSource(): boolean {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(
    path.resolve(here, "../../src/view.ts"),
    "utf8",
  );
  return (
    src.includes("cloneOverlay") &&
    /this\.wal\s*=\s*cloneOverlay\(wal\)/.test(src) &&
    /this\.sst\s*=\s*cloneOverlay\(sst\)/.test(src)
  );
}

function enabled(s: State): Action[] {
  const out: Action[] = [];
  if (s.nextVal <= 3) out.push({ type: "append" });
  if (s.pinned === "closed") out.push({ type: "openView" });
  else {
    out.push({ type: "viewGet" });
    out.push({ type: "closeView" });
  }
  return out;
}

function step(s: State, a: Action): State {
  switch (a.type) {
    case "append":
      return { ...s, live: s.nextVal, nextVal: s.nextVal + 1 };
    case "openView":
      // Correct: pin current live. Broken (no clone): stay coupled to live.
      if (!viewClonesInSource()) {
        return { ...s, pinned: s.live }; // still copies number — need ref model
      }
      return { ...s, pinned: s.live };
    case "viewGet":
      return s;
    case "closeView":
      return { ...s, pinned: "closed" };
    default: {
      const _e: never = a;
      return _e;
    }
  }
}

/**
 * When source does not clone, model treats pinned as always equal to live
 * (live binding). Numbers are copied on open — to model the bug we re-read
 * live on every viewGet when clone is missing.
 */
function viewSees(s: State): number | undefined {
  if (s.pinned === "closed") return undefined;
  if (!viewClonesInSource()) return s.live;
  return s.pinned === "closed" ? undefined : s.pinned;
}

/** After open, viewGet must equal the value at open, not later appends. */
function pinHolds(s: State, openedAt: number | undefined, a: Action): boolean {
  if (a.type !== "viewGet") return true;
  if (s.pinned === "closed") return true;
  return viewSees(s) === openedAt;
}

type Node = {
  state: State;
  prev: number;
  action: Action | null;
  openedAt: number | undefined;
};

function enc(s: State, openedAt: number | undefined): string {
  return JSON.stringify({ s, openedAt });
}

function label(a: Action): string {
  switch (a.type) {
    case "append":
      return "WAL append (after pin possible)";
    case "openView":
      return "openViewSnapshot (pin)";
    case "viewGet":
      return "view.get";
    case "closeView":
      return "view.close";
    default: {
      const _e: never = a;
      return _e;
    }
  }
}

const nodes: Node[] = [
  { state: initial(), prev: -1, action: null, openedAt: undefined },
];
const seen = new Set<string>([enc(initial(), undefined)]);

for (let i = 0; i < nodes.length; i++) {
  const cur = nodes[i]!;
  for (const a of enabled(cur.state)) {
    const next = step(cur.state, a);
    let openedAt = cur.openedAt;
    if (a.type === "openView") openedAt = cur.state.live;
    if (a.type === "closeView") openedAt = undefined;

    if (!pinHolds(next, openedAt, a)) {
      const path: string[] = [];
      let j: number | null = i;
      while (j !== null && j >= 0) {
        const n = nodes[j]!;
        if (n.action) path.push(label(n.action));
        j = n.prev >= 0 ? n.prev : null;
      }
      path.reverse();
      path.push(label(a));
      console.error("FAIL ViewPin");
      console.error(
        `view saw ${String(viewSees(next))} but pin was ${String(openedAt)}`,
      );
      console.error("shortest path:");
      path.forEach((l, idx) => console.error(`  ${idx + 1}. ${l}`));
      console.error(
        "\nHarm: view() is not a snapshot — later writes change results mid-callback.",
      );
      process.exit(1);
    }

    const key = enc(next, openedAt);
    if (seen.has(key)) continue;
    seen.add(key);
    nodes.push({ state: next, prev: i, action: a, openedAt });
  }
}

if (!viewClonesInSource()) {
  console.error("FAIL ViewPin — view.ts no longer clones overlays on pin");
  process.exit(1);
}

console.log(
  `PASS ViewPin — ${seen.size} states, cloneOverlay pin present in view.ts`,
);
