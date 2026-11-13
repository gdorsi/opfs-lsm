import { describe, expect, it } from "vitest";
import { Oracle, Reader } from "./oracle.js";

const utf = (s: string) => new TextEncoder().encode(s);

describe("oracle", () => {
  it("folds the log prefix by prefix", () => {
    const o = new Oracle();
    o.append([{ type: "put", key: utf("a"), value: utf("1") }]);
    o.append([
      { type: "put", key: utf("b"), value: utf("2") },
      { type: "del", key: utf("a") },
    ]);
    o.append([{ type: "put", key: utf("a"), value: utf("3") }]);
    expect(o.valueAt(utf("a"), 0)).toBeUndefined();
    expect(o.valueAt(utf("a"), 1)).toEqual(utf("1"));
    expect(o.valueAt(utf("a"), 2)).toBeUndefined();
    expect(o.stateAt(3).map((e) => [e.key, e.value])).toEqual([
      [utf("a"), utf("3")],
      [utf("b"), utf("2")],
    ]);
    expect(o.rangeAt({ start: utf("b") }, 1)).toEqual([]);
  });

  it("reads a range backward before it takes the limit", () => {
    const o = new Oracle();
    o.append([
      { type: "put", key: utf("a"), value: utf("1") },
      { type: "put", key: utf("b"), value: utf("2") },
      { type: "put", key: utf("c"), value: utf("3") },
      { type: "put", key: utf("d"), value: utf("4") },
    ]);
    const keys = (r: Parameters<Oracle["rangeAt"]>[0]) => o.rangeAt(r).map((e) => new TextDecoder().decode(e.key));
    expect(keys({ reverse: true })).toEqual(["d", "c", "b", "a"]);
    expect(keys({ reverse: true, limit: 2 })).toEqual(["d", "c"]);
    expect(keys({ reverse: true, start: utf("b"), endExclusive: utf("d"), limit: 1 })).toEqual(["c"]);
    expect(keys({ limit: 2 })).toEqual(["a", "b"]);
  });

  it("folds a range delete over the rows written at or before its through, never its own batch's", () => {
    const o = new Oracle();
    o.append([
      { type: "put", key: utf("a"), value: utf("1") },
      { type: "put", key: utf("b"), value: utf("1") },
    ]);
    o.append([{ type: "put", key: utf("c"), value: utf("2") }]);
    o.append([
      { type: "deleteRange", start: utf("a"), endExclusive: utf("c"), through: 1 },
      { type: "deleteRange", start: utf("c"), through: 99 },
      { type: "put", key: utf("d"), value: utf("3") },
    ]);
    o.append([{ type: "put", key: utf("b"), value: utf("4") }]);
    const state = (p: number) => o.stateAt(p).map((e) => `${new TextDecoder().decode(e.key)}=${new TextDecoder().decode(e.value)}`);
    expect(state(2)).toEqual(["a=1", "b=1", "c=2"]);
    expect(state(3)).toEqual(["d=3"]);
    expect(state(4)).toEqual(["b=4", "d=3"]);
  });

  it("keeps the last op when a batch writes a key twice", () => {
    const o = new Oracle();
    o.append([
      { type: "put", key: utf("a"), value: utf("1") },
      { type: "del", key: utf("a") },
    ]);
    expect(o.valueAt(utf("a"))).toBeUndefined();
  });

  it("rejects a read older than the reader's own ack", () => {
    const o = new Oracle();
    const r = new Reader(o);
    r.acked(o.append([{ type: "put", key: utf("a"), value: utf("1") }]));
    expect(() => r.get(utf("a"), undefined)).toThrow(/not a prefix/);
    r.get(utf("a"), utf("1"));
  });

  it("rejects a reader going backwards", () => {
    const o = new Oracle();
    o.append([{ type: "put", key: utf("a"), value: utf("1") }]);
    o.append([{ type: "put", key: utf("a"), value: utf("2") }]);
    const r = new Reader(o);
    r.get(utf("a"), utf("2"));
    expect(() => r.get(utf("a"), utf("1"))).toThrow(/not a prefix/);
  });

  it("rejects a view whose reads come from two prefixes", () => {
    const o = new Oracle();
    o.append([{ type: "put", key: utf("a"), value: utf("1") }]);
    o.append([{ type: "put", key: utf("b"), value: utf("2") }]);
    const r = new Reader(o);
    const v = r.view();
    v.get(utf("b"), undefined); // p = 0 or 1
    expect(() => v.get(utf("a"), utf("1"))).not.toThrow(); // p = 1
    expect(() => v.range({}, [{ key: utf("a"), value: utf("1") }, { key: utf("b"), value: utf("2") }])).toThrow(
      /not one prefix at or after 0/,
    );
  });
});
