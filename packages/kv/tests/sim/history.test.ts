import { describe, expect, it } from "vitest";
import { checkHistory, History } from "./history.js";
import type { OracleOp } from "./oracle.js";

const utf = (s: string) => new TextEncoder().encode(s);
const put = (k: string, v: string): OracleOp => ({ type: "put", key: utf(k), value: utf(v) });

/** A session that opened at the start of the history. */
function session(h: History): number {
  const s = h.newSession();
  h.respond(h.invoke({ kind: "open", session: s }));
  return s;
}

type Rec = { readonly log: string; readonly n: number; readonly ops: OracleOp[] };
const next = new Map<number, number>();

/** A write on `s` that acks as the next record of its log. */
function write(h: History, s: number, ops: OracleOp[]): Rec {
  const op = h.invoke({ kind: "write", session: s, ops });
  const n = (next.get(s) ?? 0) + 1;
  next.set(s, n);
  const rec = { log: `log-${s}`, n, ops };
  h.acked(s, op.id, rec.log, n, ops);
  h.respond(op);
  return rec;
}

let through = 0;
/** One ingest round: `recs` at the next seqs, and a manifest boundary after them. */
function ingest(h: History, ...recs: Rec[]): void {
  for (const r of recs) h.plan(++through, r.log, r.n, r.ops);
  h.boundary(through);
}

function fresh(): History {
  next.clear();
  through = 0;
  return new History();
}

function get(h: History, s: number, key: string, value: string | undefined): void {
  const op = h.invoke({ kind: "get", session: s, key: utf(key) });
  op.value = value === undefined ? undefined : utf(value);
  h.respond(op);
}

describe("history checker", () => {
  it("accepts reads that lag another handle's ack: no real-time promise without a barrier", () => {
    const h = fresh();
    const a = session(h);
    const b = session(h);
    const w = write(h, a, [put("k", "1")]);
    get(h, b, "k", undefined);
    get(h, a, "k", "1");
    ingest(h, w);
    expect(() => checkHistory(h, through)).not.toThrow();
  });

  it("rejects a read on the writing handle that misses its own acked write", () => {
    const h = fresh();
    const a = session(h);
    const w = write(h, a, [put("k", "1")]);
    get(h, a, "k", undefined);
    ingest(h, w);
    expect(() => checkHistory(h, through)).toThrow(/read your writes/);
  });

  it("reads a page's own records on top of the installed prefix", () => {
    const h = fresh();
    const a = session(h);
    const b = session(h);
    const mine = write(h, a, [put("k", "a")]);
    const theirs = write(h, b, [put("k", "b")]);
    // The host ingests b's write after a's: a reads its own until it installs, then b's.
    get(h, a, "k", "a");
    ingest(h, mine, theirs);
    get(h, a, "k", "b");
    expect(() => checkHistory(h, through)).not.toThrow();
  });

  it("rejects a read where an older write of another page hides the reader's own", () => {
    const h = fresh();
    const a = session(h);
    const b = session(h);
    const theirs = write(h, b, [put("k", "b")]);
    const mine = write(h, a, [put("k", "a")]);
    ingest(h, theirs, mine);
    get(h, a, "k", "b");
    expect(() => checkHistory(h, through)).toThrow(/not one state|no state/);
  });

  it("rejects a read inside an ingest round: only manifest boundaries are installed", () => {
    const h = fresh();
    const a = session(h);
    const b = session(h);
    const x = write(h, a, [put("x", "1")]);
    const y = write(h, a, [put("y", "1")]);
    ingest(h, x, y);
    const view = h.invoke({ kind: "view", session: b, reads: [] });
    view.reads.push({ kind: "get", key: utf("x"), value: utf("1") });
    view.reads.push({ kind: "get", key: utf("y"), value: undefined });
    h.respond(view);
    expect(() => checkHistory(h, through)).toThrow(/view is not one state/);
  });

  it("rejects a handle whose prefix goes backwards", () => {
    const h = fresh();
    const a = session(h);
    const b = session(h);
    const w1 = write(h, a, [put("k", "1")]);
    ingest(h, w1);
    const w2 = write(h, a, [put("k", "2")]);
    ingest(h, w2);
    get(h, b, "k", "2");
    get(h, b, "k", "1");
    expect(() => checkHistory(h, through)).toThrow(/never goes backwards/);
  });

  it("rejects a read after sync() that misses a write acked before the sync was called", () => {
    const h = fresh();
    const a = session(h);
    const b = session(h);
    const w = write(h, a, [put("k", "1")]);
    ingest(h, w);
    h.respond(h.invoke({ kind: "sync", session: b }));
    get(h, b, "k", undefined);
    expect(() => checkHistory(h, through)).toThrow(/sync barrier/);
  });

  it("allows a sync to miss a write acked after the sync was called", () => {
    const h = fresh();
    const a = session(h);
    const b = session(h);
    const sync = h.invoke({ kind: "sync", session: b });
    const w = write(h, a, [put("k", "1")]);
    h.respond(sync);
    get(h, b, "k", undefined);
    ingest(h, w);
    expect(() => checkHistory(h, through)).not.toThrow();
  });

  it("rejects a read that sees a write not invoked yet", () => {
    const h = fresh();
    const a = session(h);
    const b = session(h);
    const w1 = write(h, a, [{ type: "del", key: utf("k") }]);
    const r = h.invoke({ kind: "get", session: b, key: utf("k") });
    r.value = utf("1");
    h.respond(r);
    const w2 = write(h, a, [put("k", "1")]);
    ingest(h, w1, w2);
    expect(() => checkHistory(h, through)).toThrow(/no state/);
  });

  it("accepts two pages' updates that both read the same value: last writer wins", () => {
    const h = fresh();
    const a = session(h);
    const b = session(h);
    const zero = write(h, a, [put("c", "0")]);
    ingest(h, zero);
    const recs: Rec[] = [];
    for (const s of [a, b]) {
      const ops = [put("c", `1.${s}`)];
      const u = h.invoke({ kind: "update", session: s, keys: [utf("c")], ops });
      u.seen = [utf("0")];
      const n = (next.get(s) ?? 0) + 1;
      next.set(s, n);
      h.acked(s, u.id, `log-${s}`, n, ops);
      recs.push({ log: `log-${s}`, n, ops });
      h.respond(u);
    }
    ingest(h, ...recs);
    expect(() => checkHistory(h, through)).not.toThrow();
  });

  it("rejects an update that misses an earlier write of its own page", () => {
    const h = fresh();
    const a = session(h);
    const first = h.invoke({ kind: "write", session: a, ops: [put("c", "1")] });
    const u = h.invoke({ kind: "update", session: a, keys: [utf("c")], ops: [put("c", "2")] });
    u.seen = [undefined];
    h.acked(a, first.id, "log-a", 1, [put("c", "1")]);
    h.respond(first);
    h.acked(a, u.id, "log-a", 2, [put("c", "2")]);
    h.respond(u);
    ingest(h, { log: "log-a", n: 1, ops: [put("c", "1")] }, { log: "log-a", n: 2, ops: [put("c", "2")] });
    expect(() => checkHistory(h, through)).toThrow(/an update sees its page's writes/);
  });

  it("rejects a page's records ingested out of its ack order, twice, or never", () => {
    const h = fresh();
    const a = session(h);
    const w1 = write(h, a, [put("k", "1")]);
    const w2 = write(h, a, [put("k", "2")]);
    ingest(h, w2, w1);
    expect(() => checkHistory(h, through)).toThrow(/before a record it acked earlier/);

    const twice = fresh();
    const b = session(twice);
    const once = write(twice, b, [put("k", "1")]);
    ingest(twice, once, once);
    expect(() => checkHistory(twice, through)).toThrow(/ingested twice/);

    const never = fresh();
    write(never, session(never), [put("k", "1")]);
    expect(() => checkHistory(never, through)).toThrow(/never ingested/);
  });

  it("tolerates an error from an op whose handle closed under it, but not a corrupt-database error", () => {
    const h = fresh();
    const a = session(h);
    const op = h.invoke({ kind: "write", session: a, ops: [put("k", "1")] });
    h.respond(h.invoke({ kind: "close", session: a }));
    h.respond(op, new Error("closing"));
    expect(() => checkHistory(h, through)).not.toThrow();
    const bad = fresh();
    const b = session(bad);
    const r = bad.invoke({ kind: "get", session: b, key: utf("k") });
    const err = new Error("gone");
    err.name = "CorruptDatabaseError";
    bad.respond(r, err);
    expect(() => checkHistory(bad, through)).toThrow(/CorruptDatabaseError/);
  });
});
