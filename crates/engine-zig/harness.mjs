import { gzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { MiB, EngineError, loadZig, loadRust, genEntries, flatten, unflatten, framedBlocks, eq } from "./loader.mjs";

const rust = await loadRust();
const zigSmall = await loadZig("./engine_small.wasm");
const zigFast = await loadZig("./engine_fast.wasm");
console.log(`rust side: ${rust.abi} ABI`);

const enc = new TextEncoder();
function sameEntries(a, b) {
  if (a.length !== b.length) return `len ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.kind !== y.kind || x.seq !== y.seq || !eq(x.key, y.key) || (x.kind === "put" && !eq(x.value, y.value))) return `entry ${i} differs`;
  }
  return "ok";
}

// ---- parity ----
const N = 20000;
const entries = genEntries(N, 7);
const flat = flatten(entries);
const results = [];
const check = (name, ok, detail = "") => { results.push([name, ok ? "PASS" : "FAIL", detail]); };
const peaks = [];
const notePeak = (op) => peaks.push([op, zigSmall.peak(), zigFast.peak(), rust.peak()]);

const rRaw = rust.encodeEntries(entries, false), zRaw = zigSmall.encode(flat, false);
check("encode raw: byte-identical to Rust", eq(rRaw, zRaw), `${rRaw.length} B vs ${zRaw.length} B`);
check("decode raw: Zig decodes Rust output", sameEntries(unflatten(zigSmall.decode(rRaw)), rust.decodeEntries(rRaw)) === "ok");

const rLz = rust.encodeEntries(entries, true), zLz = zigSmall.encode(flat, true);
check("encode lz4: Rust decodes Zig output", sameEntries(rust.decodeEntries(zLz), rust.decodeEntries(rLz)) === "ok", `rust ${rLz.length} B, zig ${zLz.length} B (${(zLz.length / rLz.length * 100).toFixed(1)}% of rust)`);
check("decode lz4: Zig decodes Rust output", sameEntries(unflatten(zigSmall.decode(rLz)), rust.decodeEntries(rLz)) === "ok");
check("encode lz4: ReleaseFast == ReleaseSmall bytes", eq(zigFast.encode(flat, true), zLz));

function pats(...ps) { let n = 0; for (const p of ps) n += 4 + enc.encode(p).length; const out = new Uint8Array(n); const dv = new DataView(out.buffer); let o = 0; for (const p of ps) { const b = enc.encode(p); dv.setUint32(o, b.length, true); out.set(b, o + 4); o += 4 + b.length; } return out; }
const firstBlock = (sst) => framedBlocks(sst)[0];
const P = pats("gamma", "name-1");
check("scan raw block: identical hits", eq(rust.scan(firstBlock(rRaw), false, P), zigSmall.scan(firstBlock(rRaw), false, P)));
check("scan lz4 block (Rust-compressed): identical hits", eq(rust.scan(firstBlock(rLz), true, P), zigSmall.scan(firstBlock(rLz), true, P)));
check("scan lz4 block (Zig-compressed) via Rust == via Zig", eq(rust.scan(firstBlock(zLz), true, P), zigSmall.scan(firstBlock(zLz), true, P)));
{ const b = firstBlock(rLz); const size = new DataView(b.buffer, b.byteOffset).getUint32(0, true); check("lz4_decompress: identical", eq(rust.lz4(b.subarray(4), size), zigSmall.lz4(b.subarray(4), size))); }

// merge: 4 overlapping runs newest-first, with duplicate keys inside a run
const runs = [1, 2, 3, 4].map((s) => rust.encodeEntries(genEntries(5000, s), false));
for (const [drop, target] of [[false, Number.MAX_SAFE_INTEGER], [true, Number.MAX_SAFE_INTEGER], [true, 64 * 1024]]) {
  const r = rust.merge(runs, drop, target, false), z = zigSmall.merge(runs, drop, target, false);
  check(`merge drop=${drop} target=${target === Number.MAX_SAFE_INTEGER ? "inf" : target}: identical ssts + droppedSeq`, r.ssts.length === z.ssts.length && r.ssts.every((s, i) => eq(s, z.ssts[i])) && r.droppedSeq === z.droppedSeq, `${r.ssts.length} runs, droppedSeq ${r.droppedSeq}/${z.droppedSeq}`);
}
{
  const bad = rRaw.slice(); bad[100] ^= 1;
  const err = (fn) => { try { fn(); return null; } catch (e) { return e; } };
  const rErr = err(() => rust.decode(bad)), zErr = err(() => zigSmall.decode(bad));
  const isCrc = (e) => e instanceof EngineError && (e.code === -4 || String(e.code).includes("Crc"));
  check("corrupt byte: both reject with CRC_MISMATCH", isCrc(rErr) && isCrc(zErr), `${rErr?.code} | ${zErr?.code}`);
}

// capacity: an encode whose work exceeds the arena returns -11, and the module keeps working
{
  const bigFlat = flatten(genEntries(50000, 11));
  const tiny = await loadZig("./engine_small.wasm", { capacity: bigFlat.length + 1 * MiB });
  const zero = tiny.ex.input_ptr(bigFlat.length + 2 * MiB);
  let code = 0; try { tiny.encode(bigFlat, true); } catch (e) { code = e.code; }
  const small = flatten(genEntries(100, 3));
  let after; try { after = tiny.encode(small, true); } catch (e) { after = e; }
  const ok = zero === 0 && code === -11 && tiny.ex.result_len() === after.length && eq(after, zigSmall.encode(small, true)) && tiny.memory().growths === 0;
  check("capacity: oversized encode returns -11, then a small encode matches", ok, `cap ${tiny.ex.memory.buffer.byteLength} B mem, input_ptr(too big)=${zero}, encode 50k -> ${code}, then 100 entries -> ${after.length ?? after} B`);
}

console.log("\n== parity ==");
for (const [n, s, d] of results) console.log(`${s}  ${n}${d ? "  (" + d + ")" : ""}`);

// ---- size ----
console.log("\n== .wasm size (bytes) ==");
const gz = (b) => gzipSync(b, { level: 9 }).length;
for (const [name, b] of [[`rust (${rust.abi})`, rust.bytes], ["zig ReleaseSmall", zigSmall.bytes], ["zig ReleaseFast", zigFast.bytes]]) console.log(`${name.padEnd(26)} raw ${String(b.length).padStart(7)}  gzip ${String(gz(b)).padStart(6)}`);
console.log(`rust JS glue: ${rust.glueBytes} B; flat-ABI glue (loader.mjs loadFlat): ~2.9 kB unminified, shared by any flat module`);

// ---- timing ----
function bench(fn, reps = 15) { const t = []; for (let i = 0; i < reps; i++) { const a = performance.now(); fn(); t.push(performance.now() - a); } t.sort((x, y) => x - y); return t[Math.floor(t.length / 2)]; }
const big = genEntries(50000, 11), bigFlat = flatten(big);
const bigRaw = rust.encodeEntries(big, false), bigLz = rust.encodeEntries(big, true);
console.log(`\n== timing, median of 15, ${big.length} entries (${bigRaw.length} B raw sst) ==`);
const row = (name, r, zs, zf) => { console.log(`${name.padEnd(34)} rust ${r.toFixed(2).padStart(7)} ms   zig-small ${zs.toFixed(2).padStart(7)} ms   zig-fast ${zf.toFixed(2).padStart(7)} ms`); notePeak(name); };
const all = (fn) => [rust, zigSmall, zigFast].map((e) => bench(() => fn(e)));
const allN = (fn, reps) => [rust, zigSmall, zigFast].map((e) => bench(() => fn(e), reps));
row("encode raw (incl. JS marshalling)", ...all((e) => e.encodeEntries(big, false)));
row("encode raw (flat pre-marshalled)", ...all((e) => (e.abi === "wasm-bindgen" ? NaN : e.encode(bigFlat, false))).map((x, i) => (i === 0 && rust.abi === "wasm-bindgen" ? NaN : x)));
row("encode lz4 (incl. JS marshalling)", ...all((e) => e.encodeEntries(big, true)));
row("decode raw -> JS entries", ...all((e) => e.decodeEntries(bigRaw)));
row("decode lz4 -> JS entries", ...all((e) => e.decodeEntries(bigLz)));
const blk = firstBlock(bigLz);
row("scan lz4 block x200", ...all((e) => { for (let i = 0; i < 200; i++) e.scan(blk, true, P); }));
const mruns = [21, 22, 23, 24].map((s) => rust.encodeEntries(genEntries(20000, s), true));
row("merge 4x20k lz4 runs, drop tombs", ...allN((e) => e.merge(mruns, true, 256 * 1024, true), 7));

// peak_bytes is a high-water mark since init, so each line is the max over everything run so far
console.log("\n== peak_bytes (high-water since init, input + arena) ==");
const mb = (x) => (Number.isNaN(x) ? "n/a" : `${(x / MiB).toFixed(2)} MiB`);
for (const [op, s, f, r] of peaks) console.log(`after ${op.padEnd(34)} zig-small ${mb(s).padStart(10)}   zig-fast ${mb(f).padStart(10)}   rust ${mb(r)}`);
{
  const cases = [
    ["encode raw 50k", (e) => e.encode(bigFlat, false), bigFlat.length],
    ["encode lz4 50k", (e) => e.encode(bigFlat, true), bigFlat.length],
    ["decode raw 50k", (e) => e.decode(bigRaw), bigRaw.length],
    ["decode lz4 50k", (e) => e.decode(bigLz), bigLz.length],
    ["scan lz4 block", (e) => e.scan(blk, true, P), blk.length + P.length],
    ["merge 4x20k lz4 -> 256 KiB runs", (e) => e.merge(mruns, true, 256 * 1024, true), mruns.reduce((n, b) => n + 4 + b.length, 4)],
    ["merge 4x20k lz4 -> one run", (e) => e.merge(mruns, true, Number.MAX_SAFE_INTEGER, true), mruns.reduce((n, b) => n + 4 + b.length, 4)],
  ];
  console.log("\n== peak per operation (fresh instance each) ==");
  for (const [name, fn, inBytes] of cases) {
    const e = await loadZig("./engine_small.wasm");
    const out = fn(e); const outLen = out.length ?? out.ssts.reduce((n, s) => n + s.length, 0);
    const r = rust.abi === "flat" ? await loadRust() : null; if (r) fn(r);
    console.log(`${name.padEnd(32)} zig peak ${mb(e.peak()).padStart(10)}   rust peak ${mb(r ? r.peak() : NaN).padStart(10)}   in ${mb(inBytes)}, out ${mb(outLen)}`);
  }
}

console.log("\n== memory after init ==");
for (const e of [zigSmall, zigFast, rust]) {
  const m = e.memory();
  if (!m) { console.log(`${e.name.padEnd(18)} n/a (wasm-bindgen)`); continue; }
  console.log(`${e.name.padEnd(18)} ${m.afterInit} B after init, ${m.now} B now, ${m.calls} calls, ${m.growths} growths ${m.growths === 0 ? "PASS" : e === rust ? "(allowed: dynamic allocator)" : "FAIL"}`);
}
