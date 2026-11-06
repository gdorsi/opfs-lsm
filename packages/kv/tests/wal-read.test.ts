import { beforeEach, describe, expect, it } from "vitest";
import { checkDbName, checkKey, checkValue, opsBytes, type CheckedOp } from "../src/check.js";
import { IdBWal, WAL_READ_CHUNK } from "../src/idb/wal.js";

const NAME = "wal-read-test";
const IDB = `opfs-lsm-wal/${NAME}`;
const enc = new TextEncoder();
const dec = new TextDecoder();

function wipe(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(IDB);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

function put(i: number): CheckedOp[] {
  return [{ type: "put", key: checkKey(enc.encode(`k${i}`)), value: checkValue(enc.encode(`v${i}`)) }];
}

/** One put, in the WAL's packed byte layout: type, u32 key length, key, u32 value length, value. */
function packPut(i: number): ArrayBuffer {
  const op = put(i)[0];
  if (!op || op.type !== "put") throw new Error("expected a put");
  const out = new Uint8Array(5 + op.key.byteLength + 4 + op.value.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, 0);
  view.setUint32(1, op.key.byteLength, true);
  out.set(op.key, 5);
  const at = 5 + op.key.byteLength;
  view.setUint32(at, op.value.byteLength, true);
  out.set(op.value, at + 4);
  return out.buffer;
}

function rawRow(seq: number, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(IDB);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(["wal", "meta"], "readwrite");
      tx.objectStore("wal").put(value, seq);
      tx.objectStore("meta").put(seq, "head");
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

/** Replace the WAL with gapless seqs `1..head`, minus `missing`, and no byte counter. */
function writeSeqs(head: number, missing: readonly number[]): Promise<void> {
  const skip = new Set(missing);
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(IDB);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(["wal", "meta"], "readwrite");
      const store = tx.objectStore("wal");
      store.clear();
      for (let seq = 1; seq <= head; seq++) {
        if (!skip.has(seq)) store.put(packPut(seq), seq);
      }
      const meta = tx.objectStore("meta");
      meta.put(head, "head");
      meta.put(0, "ingestedThrough");
      meta.put(0, "generation");
      meta.delete("pendingBytes");
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

function deleteSeq(seq: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(IDB);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("wal", "readwrite");
      tx.objectStore("wal").delete(seq);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

async function seeded(count: number): Promise<IdBWal> {
  const wal = await IdBWal.open(checkDbName(NAME));
  for (let i = 1; i <= count; i++) await wal.append(put(i));
  return wal;
}

function summary(records: readonly { seq: number; ops: readonly CheckedOp[] }[]): string[] {
  return records.map((r) => `${r.seq}:${r.ops.map((op) => dec.decode(op.key)).join(",")}`);
}

beforeEach(wipe);

describe("WAL read", () => {
  it("returns every record after since and after ingestedThrough", async () => {
    const wal = await seeded(12);
    await wal.advanceIngested(4, 1, 0);
    const tail = await wal.tail(2);
    expect(tail.head).toBe(12);
    expect(tail.ingestedThrough).toBe(4);
    expect(summary(tail.records)).toEqual(
      Array.from({ length: 8 }, (_, i) => `${i + 5}:k${i + 5}`),
    );
    expect(summary(await wal.listUningested())).toEqual(summary(tail.records));
    expect(summary((await wal.tail(10)).records)).toEqual(["11:k11", "12:k12"]);
    expect((await wal.tail(12)).records).toEqual([]);
    wal.close();
  });

  it("throws on a missing seq instead of shifting the ones after it", async () => {
    const wal = await seeded(5);
    await deleteSeq(3);
    await expect(wal.tail(0)).rejects.toThrow("wal gap in seqs 1..5");
    wal.close();
  });

  it("round-trips a batch of puts, an empty value and a delete as bytes", async () => {
    const wal = await IdBWal.open(checkDbName(NAME));
    const big = new Uint8Array(70_000).map((_, i) => i & 0xff);
    await wal.append([
      { type: "put", key: checkKey(enc.encode("a")), value: checkValue(big) },
      { type: "put", key: checkKey(enc.encode("empty")), value: checkValue(new Uint8Array()) },
      { type: "del", key: checkKey(enc.encode("gone")) },
      { type: "put", key: checkKey(enc.encode("z")), value: checkValue(enc.encode("last")) },
    ]);
    const [record] = (await wal.tail(0)).records;
    const ops = record!.ops;
    expect(ops.map((op) => `${op.type}:${dec.decode(op.key)}`)).toEqual([
      "put:a",
      "put:empty",
      "del:gone",
      "put:z",
    ]);
    const value = (i: number) => (ops[i] as Extract<CheckedOp, { type: "put" }>).value;
    expect(value(0)).toEqual(big);
    expect(value(1).byteLength).toBe(0);
    expect(dec.decode(value(3))).toBe("last");
    wal.close();
  });

  it("rejects a row that is not bytes", async () => {
    const wal = await IdBWal.open(checkDbName(NAME));
    await rawRow(1, [{ type: "put", key: new ArrayBuffer(1), value: new ArrayBuffer(1) }]);
    await expect(wal.tail(0)).rejects.toThrow("corrupt wal row: not bytes");
    wal.close();
  });

  it("rejects a truncated row", async () => {
    const wal = await IdBWal.open(checkDbName(NAME));
    const row = new Uint8Array([0, 10, 0, 0, 0, 1, 2]);
    await rawRow(1, row.buffer);
    await expect(wal.tail(0)).rejects.toThrow("corrupt wal row: truncated");
    wal.close();
  });

  it(
    "reads a tail that crosses a getAll chunk, and names the short chunk",
    async () => {
      const head = WAL_READ_CHUNK + 1;
      const wal = await IdBWal.open(checkDbName(NAME));
      await writeSeqs(head, []);
      const tail = await wal.tail(0);
      expect(tail.records).toHaveLength(head);
      const edges = [tail.records[0], tail.records[WAL_READ_CHUNK - 1], tail.records[WAL_READ_CHUNK]];
      expect(summary(edges.filter((record) => record !== undefined))).toEqual([
        "1:k1",
        `${WAL_READ_CHUNK}:k${WAL_READ_CHUNK}`,
        `${head}:k${head}`,
      ]);
      expect(summary((await wal.tail(WAL_READ_CHUNK)).records)).toEqual([`${head}:k${head}`]);
      expect(await wal.listUningested()).toHaveLength(head);
      let bytes = 0;
      for (let i = 1; i <= head; i++) bytes += opsBytes(put(i));
      expect(await wal.uningestedBytes()).toBe(bytes);

      await writeSeqs(head, [head]);
      await expect(wal.tail(0)).rejects.toThrow(`wal gap in seqs ${head}..${head}`);
      await expect(wal.listUningested()).rejects.toThrow(`wal gap in seqs ${head}..${head}`);
      await expect(wal.uningestedBytes()).rejects.toThrow(`wal gap in seqs ${head}..${head}`);
      wal.close();
    },
    30_000,
  );
});
