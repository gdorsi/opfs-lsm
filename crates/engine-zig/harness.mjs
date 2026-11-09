import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const rustMod = await import(`${ROOT}/packages/kv/wasm/engine_wasm.js`);
const rustBytes = await readFile(`${ROOT}/packages/kv/wasm/engine_wasm_bg.wasm`);
await rustMod.default({ module_or_path: rustBytes });

async function loadZig(file) {
  const bytes = await readFile(new URL(file, import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;
  const mem = () => new Uint8Array(ex.memory.buffer);
  const push = (u8) => { const p = ex.alloc(u8.length); mem().set(u8, p); return p; };
  const take = (code, what) => {
    if (code !== 0) throw new Error(`${what}: zig error ${code}`);
    const out = mem().slice(ex.result_ptr(), ex.result_ptr() + ex.result_len());
    ex.result_free();
    return out;
  };
  return { bytes, ex,
    encode(flat, lz4) { const p = push(flat); const r = take(ex.encode_sst(p, flat.length, lz4), "encode"); ex.dealloc(p, flat.length); return r; },
    decode(sst) { const p = push(sst); const r = take(ex.decode_sst(p, sst.length), "decode"); ex.dealloc(p, sst.length); return r; },
    lz4(src, size) { const p = push(src); const r = take(ex.lz4_decompress(p, src.length, size), "lz4"); ex.dealloc(p, src.length); return r; },
    scan(framed, lz4, pats) { const p = push(framed), q = push(pats); const r = take(ex.scan_block_contains(p, framed.length, lz4, q, pats.length), "scan"); ex.dealloc(p, framed.length); ex.dealloc(q, pats.length); return r; },
    merge(blobs, drop, target, lz4) {
      let n = 4; for (const b of blobs) n += 4 + b.length;
      const flat = new Uint8Array(n); const dv = new DataView(flat.buffer); dv.setUint32(0, blobs.length, true);
      let o = 4; for (const b of blobs) { dv.setUint32(o, b.length, true); flat.set(b, o + 4); o += 4 + b.length; }
      const p = push(flat); const r = take(ex.merge_ssts(p, flat.length, drop, target, lz4), "merge"); ex.dealloc(p, flat.length);
      const rv = new DataView(r.buffer, r.byteOffset); const dropped = Number(rv.getBigUint64(0, true)); const count = rv.getUint32(8, true);
      const ssts = []; o = 12; for (let i = 0; i < count; i++) { const len = rv.getUint32(o, true); ssts.push(r.slice(o + 4, o + 4 + len)); o += 4 + len; }
      return { ssts, droppedSeq: dropped };
    },
  };
}
const zigSmall = await loadZig("./engine_small.wasm");
const zigFast = await loadZig("./engine_fast.wasm");

// ---- data ----
const enc = new TextEncoder();
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function genEntries(n, seed, delEvery = 10) {
  const r = rng(seed); const out = [];
  for (let i = 0; i < n; i++) {
    const key = enc.encode(`user:${String(Math.floor(r() * n * 3)).padStart(8, "0")}:field${i % 7}`);
    const seq = i + 1;
    if (i % delEvery === 5) out.push({ kind: "del", key, seq });
    else { const v = enc.encode(JSON.stringify({ i, name: "name-" + Math.floor(r() * 1000), tags: ["alpha", "beta", i % 3 ? "gamma" : "delta"], pad: "x".repeat(Math.floor(r() * 60)) })); out.push({ kind: "put", key, value: v, seq }); }
  }
  return out;
}
function flatten(entries) {
  let n = 0; for (const e of entries) n += 13 + e.key.length + (e.kind === "put" ? 4 + e.value.length : 0);
  const out = new Uint8Array(n); const dv = new DataView(out.buffer); let o = 0;
  for (const e of entries) {
    out[o] = e.kind === "put" ? 1 : 2; dv.setBigUint64(o + 1, BigInt(e.seq), true); dv.setUint32(o + 9, e.key.length, true); o += 13;
    out.set(e.key, o); o += e.key.length;
    if (e.kind === "put") { dv.setUint32(o, e.value.length, true); o += 4; out.set(e.value, o); o += e.value.length; }
  }
  return out;
}
function unflatten(flat) {
  const dv = new DataView(flat.buffer, flat.byteOffset); const out = []; let o = 0;
  while (o < flat.length) {
    const tag = flat[o]; const seq = Number(dv.getBigUint64(o + 1, true)); const kl = dv.getUint32(o + 9, true); o += 13;
    const key = flat.slice(o, o + kl); o += kl;
    if (tag === 1) { const vl = dv.getUint32(o, true); o += 4; out.push({ kind: "put", key, value: flat.slice(o, o + vl), seq }); o += vl; }
    else out.push({ kind: "del", key, seq });
  }
  return out;
}
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
function sameEntries(a, b) {
  if (a.length !== b.length) return `len ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.kind !== y.kind || x.seq !== y.seq || !eq(x.key, y.key) || (x.kind === "put" && !eq(x.value, y.value))) return `entry ${i} differs`;
  }
  return "ok";
}
const rustEnc = (entries, lz4) => rustMod.encode_sst_js(entries, lz4);
const rustDec = (sst) => rustMod.decode_sst_js(sst).map((r) => r.kind === "put" ? { kind: "put", key: new Uint8Array(r.key), value: new Uint8Array(r.value), seq: r.seq } : { kind: "del", key: new Uint8Array(r.key), seq: r.seq });

// ---- parity ----
const N = 20000;
const entries = genEntries(N, 7);
const flat = flatten(entries);
const results = [];
const check = (name, ok, detail = "") => { results.push([name, ok ? "PASS" : "FAIL", detail]); };

const rRaw = rustEnc(entries, false), zRaw = zigSmall.encode(flat, false);
check("encode raw: byte-identical to Rust", eq(rRaw, zRaw), `${rRaw.length} B vs ${zRaw.length} B`);
check("decode raw: Zig decodes Rust output", sameEntries(unflatten(zigSmall.decode(rRaw)), rustDec(rRaw)) === "ok");

const rLz = rustEnc(entries, true), zLz = zigSmall.encode(flat, true);
check("encode lz4: Rust decodes Zig output", sameEntries(rustDec(zLz), rustDec(rLz)) === "ok", `rust ${rLz.length} B, zig ${zLz.length} B (${(zLz.length / rLz.length * 100).toFixed(1)}% of rust)`);
check("decode lz4: Zig decodes Rust output", sameEntries(unflatten(zigSmall.decode(rLz)), rustDec(rLz)) === "ok");
check("encode lz4: ReleaseFast == ReleaseSmall bytes", eq(zigFast.encode(flat, true), zLz));

// one framed block from the raw/lz4 ssts for scan
function firstBlock(sst) {
  const dv = new DataView(sst.buffer, sst.byteOffset); const footer = sst.length - 44;
  const idx = dv.getUint32(footer + 20, true); let o = idx;
  const fl = dv.getUint32(o, true); o += 4 + fl; const ll = dv.getUint32(o, true); o += 4 + ll;
  const off = dv.getUint32(o, true), len = dv.getUint32(o + 4, true);
  return sst.slice(off, off + len);
}
function pats(...ps) { let n = 0; for (const p of ps) n += 4 + p.length; const out = new Uint8Array(n); const dv = new DataView(out.buffer); let o = 0; for (const p of ps) { const b = enc.encode(p); dv.setUint32(o, b.length, true); out.set(b, o + 4); o += 4 + b.length; } return out; }
const P = pats("gamma", "name-1");
check("scan raw block: identical hits", eq(rustMod.scan_block_contains_js(firstBlock(rRaw), false, P), zigSmall.scan(firstBlock(rRaw), false, P)));
check("scan lz4 block (Rust-compressed): identical hits", eq(rustMod.scan_block_contains_js(firstBlock(rLz), true, P), zigSmall.scan(firstBlock(rLz), true, P)));
check("scan lz4 block (Zig-compressed) via Rust == via Zig", eq(rustMod.scan_block_contains_js(firstBlock(zLz), true, P), zigSmall.scan(firstBlock(zLz), true, P)));
{ const b = firstBlock(rLz); const size = new DataView(b.buffer, b.byteOffset).getUint32(0, true); check("lz4_decompress: identical", eq(rustMod.lz4_decompress_js(b.subarray(4), size), zigSmall.lz4(b.subarray(4), size))); }

// merge: 4 overlapping runs newest-first, with duplicate keys inside a run
const runsE = [genEntries(5000, 1), genEntries(5000, 2), genEntries(5000, 3), genEntries(5000, 4)];
const runs = runsE.map((e) => rustEnc(e, false));
for (const [drop, target] of [[false, Number.MAX_SAFE_INTEGER], [true, Number.MAX_SAFE_INTEGER], [true, 64 * 1024]]) {
  const r = rustMod.merge_ssts_js(runs, drop, target, false), z = zigSmall.merge(runs, drop, target, false);
  check(`merge drop=${drop} target=${target === Number.MAX_SAFE_INTEGER ? "inf" : target}: identical ssts + droppedSeq`, r.ssts.length === z.ssts.length && r.ssts.every((s, i) => eq(s, z.ssts[i])) && r.droppedSeq === z.droppedSeq, `${r.ssts.length} runs, droppedSeq ${r.droppedSeq}/${z.droppedSeq}`);
}
// corruption: flip a byte
{ const bad = rRaw.slice(); bad[100] ^= 1; let rErr = "", zErr = ""; try { rustMod.decode_sst_js(bad); } catch (e) { rErr = String(e); } try { zigSmall.decode(bad); } catch (e) { zErr = String(e); } check("corrupt byte: both reject", rErr.includes("Crc") && zErr.includes("-4"), `${rErr} | ${zErr}`); }

console.log("\n== parity ==");
for (const [n, s, d] of results) console.log(`${s}  ${n}${d ? "  (" + d + ")" : ""}`);

// ---- size ----
console.log("\n== .wasm size (bytes) ==");
const gz = (b) => gzipSync(b, { level: 9 }).length;
for (const [name, b] of [["rust (wasm-pack release)", rustBytes], ["zig ReleaseSmall", zigSmall.bytes], ["zig ReleaseFast", zigFast.bytes]]) console.log(`${name.padEnd(26)} raw ${String(b.length).padStart(7)}  gzip ${String(gz(b)).padStart(6)}`);
console.log(`rust JS glue (engine_wasm.js + _bg.js): ${(await readFile(`${ROOT}/packages/kv/wasm/engine_wasm.js`)).length + (await readFile(`${ROOT}/packages/kv/wasm/engine_wasm_bg.js`)).length} B; zig glue (harness loadZig): ~1.5 kB`);

// ---- timing ----
function bench(fn, reps = 15) { const t = []; for (let i = 0; i < reps; i++) { const a = performance.now(); fn(); t.push(performance.now() - a); } t.sort((x, y) => x - y); return t[Math.floor(t.length / 2)]; }
const big = genEntries(50000, 11), bigFlat = flatten(big);
const bigRaw = rustEnc(big, false), bigLz = rustEnc(big, true);
console.log(`\n== timing, median of 15, ${big.length} entries (${bigRaw.length} B raw sst) ==`);
const row = (name, r, zs, zf) => console.log(`${name.padEnd(34)} rust ${r.toFixed(2).padStart(7)} ms   zig-small ${zs.toFixed(2).padStart(7)} ms   zig-fast ${zf.toFixed(2).padStart(7)} ms`);
row("encode raw (incl. JS marshalling)", bench(() => rustEnc(big, false)), bench(() => zigSmall.encode(flatten(big), false)), bench(() => zigFast.encode(flatten(big), false)));
row("encode raw (flat pre-marshalled)", NaN, bench(() => zigSmall.encode(bigFlat, false)), bench(() => zigFast.encode(bigFlat, false)));
row("encode lz4 (incl. JS marshalling)", bench(() => rustEnc(big, true)), bench(() => zigSmall.encode(flatten(big), true)), bench(() => zigFast.encode(flatten(big), true)));
row("decode raw -> JS entries", bench(() => rustDec(bigRaw)), bench(() => unflatten(zigSmall.decode(bigRaw))), bench(() => unflatten(zigFast.decode(bigRaw))));
row("decode lz4 -> JS entries", bench(() => rustDec(bigLz)), bench(() => unflatten(zigSmall.decode(bigLz))), bench(() => unflatten(zigFast.decode(bigLz))));
const blk = firstBlock(bigLz);
row("scan lz4 block x200", bench(() => { for (let i = 0; i < 200; i++) rustMod.scan_block_contains_js(blk, true, P); }), bench(() => { for (let i = 0; i < 200; i++) zigSmall.scan(blk, true, P); }), bench(() => { for (let i = 0; i < 200; i++) zigFast.scan(blk, true, P); }));
const mruns = [genEntries(20000, 21), genEntries(20000, 22), genEntries(20000, 23), genEntries(20000, 24)].map((e) => rustEnc(e, true));
row("merge 4x20k lz4 runs, drop tombs", bench(() => rustMod.merge_ssts_js(mruns, true, 256 * 1024, true), 7), bench(() => zigSmall.merge(mruns, true, 256 * 1024, true), 7), bench(() => zigFast.merge(mruns, true, 256 * 1024, true), 7));
