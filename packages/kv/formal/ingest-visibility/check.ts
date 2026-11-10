/**
 * Exhaustive check: ack'd puts stay visible across ingestChunk interleavings.
 *
 * Run: pnpm --filter @opfs-lsm/kv formal:ingest-visibility
 */
import {
  actionLabel,
  enabled,
  encodeState,
  initialState,
  noLostAcks,
  resolveGet,
  step,
  type Action,
  type ModelState,
} from "./model.js";
import {
  loadIngestOrderFromRepo,
  type IngestStep,
} from "./parse-ingest-order.js";

const MAX_APPENDS = 2;

type Node = {
  state: ModelState;
  prev: number;
  action: Action | null;
};

function explore(order: readonly IngestStep[]): {
  states: number;
  violation: null | { path: string[]; state: ModelState };
} {
  const start = initialState();
  const nodes: Node[] = [{ state: start, prev: -1, action: null }];
  const seen = new Map<string, number>([[encodeState(start), 0]]);

  for (let i = 0; i < nodes.length; i++) {
    const cur = nodes[i]!;
    if (!noLostAcks(cur.state)) {
      const path: string[] = [];
      let j: number | null = i;
      while (j !== null && j >= 0) {
        const n = nodes[j]!;
        if (n.action) path.push(actionLabel(n.action));
        j = n.prev >= 0 ? n.prev : null;
      }
      path.reverse();
      return {
        states: seen.size,
        violation: { path, state: cur.state },
      };
    }
    for (const a of enabled(cur.state, order, MAX_APPENDS)) {
      if (a.type === "done") continue;
      const next = step(cur.state, a, order);
      const key = encodeState(next);
      if (seen.has(key)) continue;
      seen.set(key, nodes.length);
      nodes.push({ state: next, prev: i, action: a });
    }
  }
  return { states: seen.size, violation: null };
}

function main(): void {
  const { path: sourcePath, order } = loadIngestOrderFromRepo();
  console.log(`ingest order from ${sourcePath}:`);
  console.log(`  ${order.join(" → ")}`);
  console.log(`bound: MaxAppends=${MAX_APPENDS}, one key, one in-flight ingest`);
  console.log(`property: NoLostAcks — after append, resolveGet sees that value`);
  console.log(`          until a later append supersedes it`);

  const { states, violation } = explore(order);
  if (violation) {
    console.error(`\nFAIL NoLostAcks after ${states} distinct states`);
    console.error(`resolveGet=${String(resolveGet(violation.state))} ingestedThrough=${violation.state.ingestedThrough} sst=${String(violation.state.sst)} l0Pending=${String(violation.state.l0Pending)}`);
    console.error("shortest path:");
    for (const [idx, label] of violation.path.entries()) {
      console.error(`  ${idx + 1}. ${label}`);
    }
    console.error(
      "\nHarm: a client got an ack from the IDB WAL commit, then a later get missed the key while ingestChunk was in flight (or finished in a bad order).",
    );
    process.exit(1);
  }
  console.log(`\nPASS NoLostAcks — ${states} distinct states, no violation`);
}

main();
