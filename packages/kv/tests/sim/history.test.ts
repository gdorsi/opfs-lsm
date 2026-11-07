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

/** A write on `s` that commits at the next seq and acks. */
function write(h: History, s: number, ops: OracleOp[]): number {
  const op = h.invoke({ kind: "write", session: s, ops });
  const seq = h.commit(op.id, ops);
  h.respond(op);
  return seq;
}

function get(h: History, s: number, key: string, value: string | undefined): void {
  const op = h.invoke({ kind: "get", session: s, key: utf(key) });
  op.value = value === undefined ? undefined : utf(value);
  h.respond(op);
}

describe("history checker", () => {
  it("accepts reads that lag another handle's ack: no real-time promise without sync", () => {
    const h = new History();
    const a = session(h);
    const b = session(h);
    write(h, a, [put("k", "1")]);
    get(h, b, "k", undefined);
    get(h, a, "k", "1");
    expect(() => checkHistory(h)).not.toThrow();
  });

  it("rejects a read on the writing handle that misses its own acked write", () => {
    const h = new History();
    const a = session(h);
    write(h, a, [put("k", "1")]);
    get(h, a, "k", undefined);
    expect(() => checkHistory(h)).toThrow(/read-your-writes|not the fold/);
  });

  it("rejects a handle whose prefix goes backwards", () => {
    const h = new History();
    const a = session(h);
    const b = session(h);
    write(h, a, [put("k", "1")]);
    write(h, a, [put("k", "2")]);
    get(h, b, "k", "2");
    get(h, b, "k", "1");
    expect(() => checkHistory(h)).toThrow(/backwards|not the fold/);
  });

  it("rejects a read after sync() that misses a write acked before the sync was called", () => {
    const h = new History();
    const a = session(h);
    const b = session(h);
    write(h, a, [put("k", "1")]);
    h.respond(h.invoke({ kind: "sync", session: b }));
    get(h, b, "k", undefined);
    expect(() => checkHistory(h)).toThrow(/sync|not the fold/);
  });

  it("allows a sync to miss a write acked after the sync was called", () => {
    const h = new History();
    const a = session(h);
    const b = session(h);
    const sync = h.invoke({ kind: "sync", session: b });
    write(h, a, [put("k", "1")]);
    h.respond(sync);
    get(h, b, "k", undefined);
    expect(() => checkHistory(h)).not.toThrow();
  });

  it("rejects a view whose reads use two prefixes", () => {
    const h = new History();
    const a = session(h);
    write(h, a, [put("x", "1")]);
    write(h, a, [put("y", "1")]);
    const b = session(h);
    const view = h.invoke({ kind: "view", session: b, reads: [] });
    view.reads.push({ kind: "get", key: utf("x"), value: undefined });
    view.reads.push({ kind: "get", key: utf("y"), value: utf("1") });
    h.respond(view);
    expect(() => checkHistory(h)).toThrow(/view/);
  });

  it("rejects a read that sees a write not invoked yet", () => {
    const h = new History();
    const a = session(h);
    const b = session(h);
    write(h, a, [{ type: "del", key: utf("k") }]);
    const r = h.invoke({ kind: "get", session: b, key: utf("k") });
    r.value = utf("1");
    h.respond(r);
    write(h, a, [put("k", "1")]);
    expect(() => checkHistory(h)).toThrow(/not the fold/);
  });

  it("rejects an update that read anything but the state just before its own seq (a lost update)", () => {
    const h = new History();
    const a = session(h);
    const b = session(h);
    write(h, a, [put("c", "0")]);
    // Both handles read "0" and write "1": the second increment is lost.
    for (const s of [a, b]) {
      const u = h.invoke({ kind: "update", session: s, keys: [utf("c")], ops: [put("c", `1.${s}`)] });
      u.seen = [utf("0")];
      h.commit(u.id, u.ops);
      h.respond(u);
    }
    expect(() => checkHistory(h)).toThrow(/update/);
  });

  it("rejects seqs that disagree with real-time write order", () => {
    const h = new History();
    const a = session(h);
    const b = session(h);
    // Concurrent writes may commit in either order.
    const first = h.invoke({ kind: "write", session: a, ops: [put("k", "1")] });
    const second = h.invoke({ kind: "write", session: b, ops: [put("k", "2")] });
    h.commit(second.id, second.ops);
    h.respond(second);
    h.commit(first.id, first.ops);
    h.respond(first);
    expect(() => checkHistory(h)).not.toThrow();
    const bad = new History();
    const s = session(bad);
    const w1 = bad.invoke({ kind: "write", session: s, ops: [put("k", "1")] });
    bad.respond(w1);
    const w2 = bad.invoke({ kind: "write", session: s, ops: [put("k", "2")] });
    bad.commit(w2.id, w2.ops);
    bad.commit(w1.id, w1.ops);
    bad.respond(w2);
    expect(() => checkHistory(bad)).toThrow(/real-time/);
  });

  it("tolerates an error from an op whose handle closed under it, but not a corrupt-database error", () => {
    const h = new History();
    const a = session(h);
    const op = h.invoke({ kind: "write", session: a, ops: [put("k", "1")] });
    h.respond(h.invoke({ kind: "close", session: a }));
    h.respond(op, new Error("closing"));
    expect(() => checkHistory(h)).not.toThrow();
    const bad = new History();
    const b = session(bad);
    const r = bad.invoke({ kind: "get", session: b, key: utf("k") });
    const err = new Error("gone");
    err.name = "CorruptDatabaseError";
    bad.respond(r, err);
    expect(() => checkHistory(bad)).toThrow(/CorruptDatabaseError/);
  });
});
