import { readFile, access } from "node:fs/promises";

export const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
export const MiB = 1024 * 1024;

export class EngineError extends Error {
  constructor(what, code) { super(`${what}: engine error ${code}`); this.code = code; }
}

// One binding for any module on the flat ABI in crates/engine-abi.md.
// `fixedMemory` makes any growth of wasm memory after init throw.
export async function loadFlat(bytes, { capacity = 256 * MiB, fixedMemory = false, name = "engine" } = {}) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;
  const status = ex.init(capacity);
  if (status !== 0) throw new EngineError(`${name} init(${capacity})`, status);
  const memAfterInit = ex.memory.buffer.byteLength;
  let calls = 0, growths = 0, last = memAfterInit;
  const mem = () => new Uint8Array(ex.memory.buffer);
  const checkMemory = (what) => {
    calls++;
    const now = ex.memory.buffer.byteLength;
    if (now === last) return;
    growths++; last = now;
    if (fixedMemory) throw new Error(`${name} ${what}: memory grew from ${memAfterInit} to ${now} B after init`);
  };
  const pack = (...parts) => {
    const len = parts.reduce((n, p) => n + p.length, 0);
    const base = ex.input_ptr(len);
    if (base === 0) throw new EngineError(`${name} input_ptr(${len})`, -11);
    const ptrs = []; let o = base;
    for (const p of parts) { mem().set(p, o); ptrs.push(o); o += p.length; }
    return ptrs;
  };
  const take = (code, what) => {
    checkMemory(what);
    if (code !== 0) throw new EngineError(`${name} ${what}`, code);
    const p = ex.result_ptr();
    return mem().slice(p, p + ex.result_len());
  };
  return {
    bytes, ex, name,
    memory: () => ({ afterInit: memAfterInit, now: ex.memory.buffer.byteLength, calls, growths }),
    peak: () => (ex.peak_bytes ? ex.peak_bytes() : NaN),
    encode(flat, lz4) { const [p] = pack(flat); return take(ex.encode_sst(p, flat.length, lz4 ? 1 : 0), "encode"); },
    decode(sst) { const [p] = pack(sst); return take(ex.decode_sst(p, sst.length), "decode"); },
    lz4(src, size) { const [p] = pack(src); return take(ex.lz4_decompress(p, src.length, size), "lz4"); },
    scan(framed, lz4, pats) { const [p, q] = pack(framed, pats); return take(ex.scan_block_contains(p, framed.length, lz4 ? 1 : 0, q, pats.length), "scan"); },
    merge(blobs, drop, target, lz4) {
      let n = 4; for (const b of blobs) n += 4 + b.length;
      const flat = new Uint8Array(n); const dv = new DataView(flat.buffer); dv.setUint32(0, blobs.length, true);
      let o = 4; for (const b of blobs) { dv.setUint32(o, b.length, true); flat.set(b, o + 4); o += 4 + b.length; }
      const [p] = pack(flat);
      const r = take(ex.merge_ssts(p, flat.length, drop ? 1 : 0, target, lz4 ? 1 : 0), "merge");
      const rv = new DataView(r.buffer, r.byteOffset); const droppedSeq = Number(rv.getBigUint64(0, true)); const count = rv.getUint32(8, true);
      const ssts = []; o = 12; for (let i = 0; i < count; i++) { const len = rv.getUint32(o, true); ssts.push(r.slice(o + 4, o + 4 + len)); o += 4 + len; }
      return { ssts, droppedSeq };
    },
    encodeEntries(entries, lz4) { return this.encode(flatten(entries), lz4); },
    decodeEntries(sst) { return unflatten(this.decode(sst)); },
  };
}

export const loadZig = async (file, opts = {}) =>
  loadFlat(await readFile(new URL(file, import.meta.url)), { fixedMemory: true, name: file, ...opts });

// The Rust build on the flat ABI (packages/kv/wasm/engine.wasm) when present, else the
// wasm-bindgen build wrapped to the same interface.
export async function loadRust() {
  const flatPath = `${ROOT}/packages/kv/wasm/engine.wasm`;
  if (await access(flatPath).then(() => true, () => false)) {
    const bytes = await readFile(flatPath);
    return { ...(await loadFlat(bytes, { name: "rust" })), abi: "flat", glueBytes: 0 };
  }
  const mod = await import(`${ROOT}/packages/kv/wasm/engine_wasm.js`);
  const bytes = await readFile(`${ROOT}/packages/kv/wasm/engine_wasm_bg.wasm`);
  await mod.default({ module_or_path: bytes });
  const glueBytes = (await readFile(`${ROOT}/packages/kv/wasm/engine_wasm.js`)).length + (await readFile(`${ROOT}/packages/kv/wasm/engine_wasm_bg.js`)).length;
  const toEntries = (rows) => rows.map((r) => r.kind === "put" ? { kind: "put", key: new Uint8Array(r.key), value: new Uint8Array(r.value), seq: r.seq } : { kind: "del", key: new Uint8Array(r.key), seq: r.seq });
  const wrap = (what, fn) => { try { return fn(); } catch (e) { throw new EngineError(`rust ${what}`, String(e)); } };
  return {
    bytes, name: "rust", abi: "wasm-bindgen", glueBytes,
    memory: () => null, peak: () => NaN,
    encodeEntries: (entries, lz4) => wrap("encode", () => mod.encode_sst_js(entries, lz4)),
    decodeEntries: (sst) => wrap("decode", () => toEntries(mod.decode_sst_js(sst))),
    encode(flat, lz4) { return this.encodeEntries(unflatten(flat), lz4); },
    decode(sst) { return flatten(this.decodeEntries(sst)); },
    lz4: (src, size) => wrap("lz4", () => mod.lz4_decompress_js(src, size)),
    scan: (framed, lz4, pats) => wrap("scan", () => mod.scan_block_contains_js(framed, lz4, pats)),
    merge: (blobs, drop, target, lz4) => wrap("merge", () => mod.merge_ssts_js(blobs, drop, target, lz4)),
  };
}

const enc = new TextEncoder();
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
export function genEntries(n, seed, delEvery = 10) {
  const r = rng(seed); const out = [];
  for (let i = 0; i < n; i++) {
    const key = enc.encode(`user:${String(Math.floor(r() * n * 3)).padStart(8, "0")}:field${i % 7}`);
    const seq = i + 1;
    if (i % delEvery === 5) out.push({ kind: "del", key, seq });
    else { const v = enc.encode(JSON.stringify({ i, name: "name-" + Math.floor(r() * 1000), tags: ["alpha", "beta", i % 3 ? "gamma" : "delta"], pad: "x".repeat(Math.floor(r() * 60)) })); out.push({ kind: "put", key, value: v, seq }); }
  }
  return out;
}
export function flatten(entries) {
  let n = 0; for (const e of entries) n += 13 + e.key.length + (e.kind === "put" ? 4 + e.value.length : 0);
  const out = new Uint8Array(n); const dv = new DataView(out.buffer); let o = 0;
  for (const e of entries) {
    out[o] = e.kind === "put" ? 1 : 2; dv.setBigUint64(o + 1, BigInt(e.seq), true); dv.setUint32(o + 9, e.key.length, true); o += 13;
    out.set(e.key, o); o += e.key.length;
    if (e.kind === "put") { dv.setUint32(o, e.value.length, true); o += 4; out.set(e.value, o); o += e.value.length; }
  }
  return out;
}
export function unflatten(flat) {
  const dv = new DataView(flat.buffer, flat.byteOffset); const out = []; let o = 0;
  while (o < flat.length) {
    const tag = flat[o]; const seq = Number(dv.getBigUint64(o + 1, true)); const kl = dv.getUint32(o + 9, true); o += 13;
    const key = flat.slice(o, o + kl); o += kl;
    if (tag === 1) { const vl = dv.getUint32(o, true); o += 4; out.push({ kind: "put", key, value: flat.slice(o, o + vl), seq }); o += vl; }
    else out.push({ kind: "del", key, seq });
  }
  return out;
}
// Every framed data block of an SST, in index order.
export function framedBlocks(sst) {
  const dv = new DataView(sst.buffer, sst.byteOffset); const footer = sst.length - 44;
  const nb = dv.getUint32(footer + 4, true); let o = dv.getUint32(footer + 20, true); const out = [];
  for (let b = 0; b < nb; b++) {
    const fl = dv.getUint32(o, true); o += 4 + fl; const ll = dv.getUint32(o, true); o += 4 + ll;
    const off = dv.getUint32(o, true), len = dv.getUint32(o + 4, true); o += 8;
    out.push(sst.slice(off, off + len));
  }
  return out;
}
export const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
