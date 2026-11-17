import fc from "fast-check";
import { expect, test } from "vitest";
import { compareBytes, toBase64url } from "../src/bytes.js";
import { SpacesError } from "../src/errors.js";
import { between, isIdText, keyedRecordId, newRecordId, parseRecordId, recordBytes, tagOf } from "../src/ids.js";
import type { SpaceId } from "../src/ids.js";
import { fieldHash, parseKey, recordKey, richTextKey, Tag } from "../src/local/keys.js";
import type { CollId } from "../src/local/keys.js";
import { applyLocal, diffEntries, mergeRemote } from "../src/local/merge.js";
import {
  Clock,
  compareStamps,
  decodeOutbox,
  decodeRecord,
  decodeTomb,
  decodeWireState,
  encodeOutbox,
  encodeRecord,
  encodeTomb,
  readFields,
  stampBytes,
  stateBytes,
  UNSET,
} from "../src/local/record.js";
import type { Cell, RecordState, Stamp, StoredRecord } from "../src/local/record.js";
import { decodeTuple, encodeTuple, encodeTuplePrefix, tupleRange } from "../src/local/tuple.js";
import type { Scalar } from "../src/schema.js";
import { randomSpace } from "./local-util.js";

const scalar = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.string({ unit: "grapheme" }).filter((s) => s.isWellFormed()),
);

// The order docstore documents: null < false < true < numbers < strings.
function compareScalars(a: Scalar, b: Scalar): number {
  const rank = (v: Scalar) => (v === null ? 0 : v === false ? 1 : v === true ? 2 : typeof v === "number" ? 3 : 4);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (typeof a === "number") return a - (b as number);
  if (typeof a === "string") {
    // UTF-8 byte order, which is code point order
    const x = [...a].map((c) => c.codePointAt(0)!);
    const y = [...(b as string)].map((c) => c.codePointAt(0)!);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
    return x.length - y.length;
  }
  return 0;
}

test("tuple encoding round-trips and preserves order", () => {
  fc.assert(
    fc.property(scalar, scalar, (a, b) => {
      expect(decodeTuple(encodeTuple([a, b]))).toEqual([a === 0 ? 0 : a, b === 0 ? 0 : b]);
      const cmp = Math.sign(compareScalars(a, b));
      const bytes = Math.sign(compareBytes(encodeTuple([a]), encodeTuple([b])));
      expect(bytes).toBe(a === 0 && b === 0 ? 0 : cmp);
    }),
  );
  expect(decodeTuple(encodeTuple(["a\u0000b", "", -0]))).toEqual(["a\u0000b", "", 0]);
});

test("tuple ranges: a prefix holds exactly the keys that start with it, including ids with 0xFF bytes", () => {
  const prefix = new Uint8Array([1, 2]);
  const key = (values: Scalar[], id: number[]) => new Uint8Array([...prefix, ...encodeTuple(values), 0, ...id]);
  const inRange = (k: Uint8Array, r: { start: Uint8Array; endExclusive?: Uint8Array }) =>
    compareBytes(k, r.start) >= 0 && (r.endExclusive === undefined || compareBytes(k, r.endExclusive) < 0);
  const idFF = [255, 255, 255];
  const r = tupleRange(prefix, 2, { eq: ["a"] });
  expect(inRange(key(["a", 1], idFF), r)).toBe(true);
  expect(inRange(key(["a", "z"], [0]), r)).toBe(true);
  expect(inRange(key(["b", 1], [0]), r)).toBe(false);
  expect(inRange(key(["a\u0000"], [0]), tupleRange(prefix, 1, { eq: ["a"] }))).toBe(false);
  const gt = tupleRange(prefix, 1, { gt: "a" });
  expect(inRange(key(["a"], idFF), gt)).toBe(false);
  expect(inRange(key(["a0"], [0]), gt)).toBe(true);
  const sw = tupleRange(prefix, 1, { startsWith: "ab" });
  expect(inRange(key(["abc"], idFF), sw)).toBe(true);
  expect(inRange(key(["ab"], idFF), sw)).toBe(true);
  expect(inRange(key(["ac"], [0]), sw)).toBe(false);
  expect(encodeTuplePrefix([], "ab")).toEqual(new Uint8Array([5, 97, 98]));
  expect(() => tupleRange(prefix, 1, { eq: ["a"], gt: 1 })).toThrow(SpacesError);
  expect(() => tupleRange(prefix, 1, { eq: [Number.NaN] })).toThrow(SpacesError);
});

test("stamps order by (ms, counter, session), text order is byte order, and the clock never repeats", () => {
  let wall = 1_000;
  const clock = new Clock(0xffffffff, () => wall);
  const a = clock.next();
  const b = clock.next(); // same ms: the counter moves
  wall = 999; // the clock is set back
  const c = clock.next();
  expect(a < b && b < c).toBe(true);
  expect(a).toHaveLength(16);
  wall = 5_000;
  const d = clock.next();
  expect(d > c).toBe(true);
  const floor = new Clock(1, () => 9_000_000).next();
  clock.observe(floor);
  expect(clock.next() > floor).toBe(true);
  expect(clock.next(floor) > floor).toBe(true);
  expect(compareStamps(a, b)).toBe(-1);
  expect(compareStamps(b, b)).toBe(0);
  fc.assert(
    fc.property(fc.array(fc.integer({ min: 0, max: 2 ** 40 }), { minLength: 2, maxLength: 20 }), (times) => {
      const k = new Clock(7, () => 0);
      const stamps: Stamp[] = [];
      for (const t of times) {
        const clk = new Clock(7, () => t);
        stamps.push(clk.next());
      }
      const byText = [...stamps].sort();
      const byBytes = [...stamps].sort((x, y) => compareBytes(stampBytes(x), stampBytes(y)));
      expect(byText).toEqual(byBytes);
      expect(k.session).toBe(7);
    }),
  );
  const many = new Clock(1, () => 10);
  const seen = new Set<string>();
  for (let i = 0; i < 70_000; i++) seen.add(many.next()); // overflows the 16-bit counter
  expect(seen.size).toBe(70_000);
});

const cell = (stamp: Stamp, value: Cell["value"], valid = true): Cell => ({ stamp, value, valid });

test("the record codec: fields slice, wire plaintext view, invalid cells and unset cells", () => {
  const clock = new Clock(1, () => 100);
  const [s1, s2, s3, s4] = [clock.next(), clock.next(), clock.next(), clock.next()];
  const state: RecordState = {
    coll: "todos",
    cells: new Map([
      ["title", cell(s1!, "héllo")],
      ["done", cell(s2!, true)],
      ["gone", cell(s3!, UNSET)],
      ["newer", cell(s4!, { nested: [1, null] }, false)],
      ["blank", cell(s1!, UNSET, false)],
    ]),
  };
  const record: StoredRecord = { readable: true, state };
  const bytes = encodeRecord(record);
  expect(readFields(bytes)).toEqual({ title: "héllo", done: true });
  const back = decodeRecord(bytes);
  expect(back.readable).toBe(true);
  expect([...back.state.cells]).toEqual([...state.cells]);
  const wire = decodeWireState(stateBytes(bytes));
  expect(wire.coll).toBe("todos");
  expect(wire.cells.get("newer")).toEqual({ stamp: s4, value: { nested: [1, null] } });
  expect(wire.cells.get("blank")?.value).toBe(UNSET);
  expect(wire.cells.get("gone")?.value).toBe(UNSET);
  expect(stateBytes(bytes).buffer).toBe(bytes.buffer); // a view, no copy
  expect(readFields(encodeRecord({ ...record, readable: false }))).toBeUndefined();
  // materialized defaults stay in the slice and are not cells
  const withDefault = encodeRecord(record, { title: "héllo", extra: 1 });
  expect(readFields(withDefault)).toEqual({ title: "héllo", extra: 1 });
  expect(decodeRecord(withDefault).state.cells.has("extra")).toBe(false);
  expect(() => decodeWireState(new Uint8Array([0, 0, 0, 2, 123, 125]))).toThrow(SpacesError);
});

test("tombstone and outbox codecs", () => {
  const stamp = new Clock(1, () => 5).next();
  expect(decodeTomb(encodeTomb({ coll: "todos", deletedAt: stamp }))).toEqual({ coll: "todos", deletedAt: stamp });
  const o = { tomb: true, coll: 3 as CollId, stamp };
  expect(decodeOutbox(encodeOutbox(o))).toEqual(o);
  expect(() => decodeTomb(new Uint8Array([1]))).toThrow(SpacesError);
});

test("merge: per field max by stamp, commutative, associative, idempotent", () => {
  const stamps = Array.from({ length: 6 }, (_, i) => new Clock(i, () => 1000 + (i % 3)).next());
  const fields = ["a", "b", "c"];
  const stateArb = fc
    .array(fc.tuple(fc.constantFrom(...fields), fc.constantFrom(...stamps)), { maxLength: 6 })
    .map((pairs): RecordState => {
      const cells = new Map<string, Cell>();
      for (const [f, s] of pairs) if (!cells.has(f)) cells.set(f, cell(s, `${f}${s}`));
      return { coll: "c", cells };
    });
  const view = (s: RecordState) => [...s.cells].map(([k, c]) => [k, c.stamp, c.value]).sort();
  fc.assert(
    fc.property(stateArb, stateArb, stateArb, (x, y, z) => {
      const xy = mergeRemote(x, y).next;
      const yx = mergeRemote(y, x).next;
      // equal stamps hold equal values here, so the winner is the same either way
      expect(view(xy)).toEqual(view(yx));
      expect(view(mergeRemote(mergeRemote(x, y).next, z).next)).toEqual(view(mergeRemote(x, mergeRemote(y, z).next).next));
      const again = mergeRemote(xy, y);
      expect(again.changed).toBe(false);
      expect(mergeRemote(x, x).changed).toBe(false);
      expect(mergeRemote(x, x).localAhead).toBe(false);
    }),
  );
  const s = stamps;
  const local: RecordState = { coll: "c", cells: new Map([["a", cell(s[5]!, "mine")]]) };
  expect(mergeRemote(local, { coll: "c", cells: new Map([["a", cell(s[0]!, "old")]]) })).toMatchObject({ changed: false, localAhead: true });
  expect(mergeRemote(local, { coll: "c", cells: new Map() })).toMatchObject({ changed: false, localAhead: true });
  expect(mergeRemote(undefined, { coll: "c", cells: new Map() }).changed).toBe(true);
  expect(applyLocal(local, "c", new Map([["b", 1]]), s[5]!).cells.size).toBe(2);
  expect(diffEntries([new Uint8Array([1]), new Uint8Array([2])], [new Uint8Array([2]), new Uint8Array([3])])).toEqual({
    put: [new Uint8Array([3])],
    del: [new Uint8Array([1])],
  });
});

test("ids: tag, canonical text, keyed ids", async () => {
  const space = randomSpace();
  const id = newRecordId(space);
  expect(id).toHaveLength(22);
  expect(tagOf(id)).toEqual(tagOf(space));
  expect(tagOf(space)).toHaveLength(8);
  expect(recordBytes(id)).toHaveLength(16);
  expect(parseRecordId(id, "lists")).toBe(id);
  expect(() => parseRecordId("short", "lists")).toThrow(SpacesError);
  expect(isIdText(id.slice(0, 21) + "B")).toBe(id.endsWith("B") || false);
  const k1 = await keyedRecordId(space, "lists", "k");
  expect(k1).toBe(await keyedRecordId(space, "lists", "k"));
  expect(k1).not.toBe(await keyedRecordId(space, "lists", "k2"));
  expect(k1).not.toBe(await keyedRecordId(space, "other", "k"));
  expect(tagOf(k1)).toEqual(tagOf(space));
  expect(new Set(Array.from({ length: 100 }, () => newRecordId(space))).size).toBe(100);
});

test("keys: parseKey reads back what the builders wrote", () => {
  const id = recordBytes(newRecordId(randomSpace()));
  expect(parseKey(recordKey(4 as CollId, id))).toEqual({ tag: Tag.record, coll: 4, id });
  const field = fieldHash("body");
  expect(parseKey(richTextKey(id, field, 9, 1))).toMatchObject({ tag: Tag.richText, field, origin: 9 });
  expect(parseKey(new Uint8Array([0x64, 1]))).toEqual({ tag: "other" });
  expect(fieldHash("body")).toBe(fieldHash("body"));
  expect(fieldHash("a")).not.toBe(fieldHash("b"));
});

// ---- between ---------------------------------------------------------------

test("between sorts strictly between its bounds", () => {
  fc.assert(
    fc.property(fc.array(fc.nat(), { minLength: 1, maxLength: 200 }), (picks) => {
      // Insert at random spots of a growing list and check it stays strictly ordered.
      const list: string[] = [];
      for (const pick of picks) {
        const at = list.length === 0 ? 0 : pick % (list.length + 1);
        const position = between(list[at - 1], list[at]);
        list.splice(at, 0, position);
      }
      for (let i = 1; i < list.length; i++) expect(list[i - 1]! < list[i]!).toBe(true);
      expect(list.every((p) => !p.endsWith("0"))).toBe(true);
    }),
  );
});

test("between: repeated inserts at the same spot stay ordered, concurrent ones differ", () => {
  let head = between();
  const first = head;
  for (let i = 0; i < 300; i++) {
    const next = between(undefined, head);
    expect(next < head).toBe(true);
    head = next;
  }
  let tail = first;
  for (let i = 0; i < 300; i++) {
    const next = between(tail, undefined);
    expect(next > tail).toBe(true);
    tail = next;
  }
  const lo = between();
  const hi = between(lo);
  const mids = new Set(Array.from({ length: 50 }, () => between(lo, hi)));
  expect(mids.size).toBe(50);
  for (const m of mids) expect(lo < m && m < hi).toBe(true);
  // adjacent digits, and a prefix upper bound
  expect(between("a0", "a1") > "a0").toBe(true);
  expect(between("a0", "a1") < "a1").toBe(true);
  expect(between("a0", "a01") < "a01").toBe(true);
  expect(between("a0V", "a1") < "a1").toBe(true);
  expect(() => between("a1", "a0")).toThrow(SpacesError);
  expect(() => between("a10")).toThrow(SpacesError);
  expect(() => between("b")).toThrow(SpacesError);
  expect(() => between("a!")).toThrow(SpacesError);
});

test("between stays short under 20,000 appends and 20,000 prepends", () => {
  let tail = between();
  let head = tail;
  let longestAppend = tail.length;
  let longestPrepend = head.length;
  for (let i = 0; i < 20_000; i++) {
    const next = between(tail, undefined);
    expect(next > tail).toBe(true);
    tail = next;
    longestAppend = Math.max(longestAppend, tail.length);
    const before = between(undefined, head);
    expect(before < head).toBe(true);
    head = before;
    longestPrepend = Math.max(longestPrepend, head.length);
  }
  // an integer head of 4 chars plus the 4-char suffix
  expect(longestAppend).toBeLessThanOrEqual(8);
  expect(longestPrepend).toBeLessThanOrEqual(9);
  expect(head < tail).toBe(true);
});

test("random inserts into a long list always sort strictly between their neighbours", () => {
  const list = [between()];
  let state = 12345;
  const next = () => (state = (state * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < 3000; i++) {
    const at = next() % (list.length + 1);
    const position = between(list[at - 1], list[at]);
    if (at > 0) expect(list[at - 1]! < position).toBe(true);
    if (at < list.length) expect(position < list[at]!).toBe(true);
    list.splice(at, 0, position);
  }
  expect(Math.max(...list.map((p) => p.length))).toBeLessThan(40);
});

test("between ordering property over arbitrary pairs of made positions", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 40 }), fc.integer({ min: 0, max: 40 }), (x, y) => {
      let a = between();
      let b = between(a);
      for (let i = 0; i < x; i++) a = between(a, b);
      for (let i = 0; i < y; i++) b = between(a, b);
      expect(a < b).toBe(true);
      const m = between(a, b);
      expect(a < m && m < b).toBe(true);
    }),
  );
  expect(toBase64url(new Uint8Array(0))).toBe("");
  expect(randomSpace() as SpaceId).toBeTruthy();
});
