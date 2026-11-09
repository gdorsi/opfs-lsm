import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const rust = await import(`${ROOT}/packages/kv/wasm/engine_wasm.js`);
await rust.default({ module_or_path: await readFile(`${ROOT}/packages/kv/wasm/engine_wasm_bg.wasm`) });
async function load(f) { const { instance } = await WebAssembly.instantiate(await readFile(f), {}); const ex = instance.exports; const mem = () => new Uint8Array(ex.memory.buffer);
  const push = (u8) => { const p = ex.alloc(u8.length); mem().set(u8, p); return p; };
  return { ex, lz4(src, size) { const p = push(src); const c = ex.lz4_decompress(p, src.length, size); if (c) throw new Error("zig " + c); const r = mem().slice(ex.result_ptr(), ex.result_ptr() + ex.result_len()); ex.result_free(); ex.dealloc(p, src.length); return r; },
    lz4Time(src, size) { const p = push(src); ex.lz4_decompress(p, src.length, size); ex.result_free(); ex.dealloc(p, src.length); },
    encode(flat, lz4) { const p = push(flat); const c = ex.encode_sst(p, flat.length, lz4); if (c) throw new Error("zig " + c); const r = mem().slice(ex.result_ptr(), ex.result_ptr() + ex.result_len()); ex.result_free(); ex.dealloc(p, flat.length); return r; } }; }
const v3 = await load("./engine_fast.wasm"), v3s = await load("./engine_small.wasm");
const enc = new TextEncoder();
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function gen(n, seed) { const r = rng(seed), out = []; for (let i = 0; i < n; i++) { const key = enc.encode(`user:${String(Math.floor(r() * n * 3)).padStart(8, "0")}:field${i % 7}`); if (i % 10 === 5) out.push({ kind: "del", key, seq: i + 1 }); else out.push({ kind: "put", key, value: enc.encode(JSON.stringify({ i, name: "name-" + Math.floor(r() * 1000), tags: ["alpha", "beta", i % 3 ? "gamma" : "delta"], pad: "x".repeat(Math.floor(r() * 60)) })), seq: i + 1 }); } return out; }
function flatten(entries) { let n = 0; for (const e of entries) n += 13 + e.key.length + (e.kind === "put" ? 4 + e.value.length : 0); const out = new Uint8Array(n); const dv = new DataView(out.buffer); let o = 0; for (const e of entries) { out[o] = e.kind === "put" ? 1 : 2; dv.setBigUint64(o + 1, BigInt(e.seq), true); dv.setUint32(o + 9, e.key.length, true); o += 13; out.set(e.key, o); o += e.key.length; if (e.kind === "put") { dv.setUint32(o, e.value.length, true); o += 4; out.set(e.value, o); o += e.value.length; } } return out; }
function blocks(sst) { const dv = new DataView(sst.buffer, sst.byteOffset); const footer = sst.length - 44; const nb = dv.getUint32(footer + 4, true); let o = dv.getUint32(footer + 20, true); const out = []; for (let b = 0; b < nb; b++) { const fl = dv.getUint32(o, true); o += 4 + fl; const ll = dv.getUint32(o, true); o += 4 + ll; const off = dv.getUint32(o, true), len = dv.getUint32(o + 4, true); o += 8; const blk = sst.slice(off, off + len); out.push({ body: blk.subarray(4), size: new DataView(blk.buffer, blk.byteOffset).getUint32(0, true) }); } return out; }
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// correctness across every block of realistic data (Rust- and Zig-compressed) and pathological values
let checked = 0, bad = 0;
const sets = [["realistic/rust-compressed", rust.encode_sst_js(gen(30000, 5), true)], ["realistic/zig-compressed", v3.encode(flatten(gen(30000, 5)), true)]];
const patho = []; const pats = ["a", "ab", "abc", "abcd", "abcde", "abcdef", "abcdefg", "abcdefgh", "0123456789abcdef", "xy"];
for (let i = 0; i < 4000; i++) { const p = pats[i % pats.length]; patho.push({ kind: "put", key: enc.encode("k" + String(i).padStart(5, "0")), value: enc.encode(p.repeat(1 + (i * 7) % 40) + (i % 3 ? "" : "tail") ), seq: i }); }
sets.push(["periodic/zig-compressed", v3.encode(flatten(patho), true)], ["periodic/rust-compressed", rust.encode_sst_js(patho, true)]);
for (const [name, sst] of sets) { let n = 0; for (const { body, size } of blocks(sst)) { const r = rust.lz4_decompress_js(body, size); for (const z of [v3, v3s]) { checked++; if (!eq(r, z.lz4(body, size))) { bad++; console.log("MISMATCH", name, "block", n); } } n++; } console.log(`${name}: ${n} blocks`); }
// truncated / corrupted inputs must error, not crash
let rejects = 0, tries = 0, zigStricter = 0, zigLaxer = 0; { const { body, size } = blocks(sets[0][1])[3]; for (let cut = 0; cut < body.length; cut += 7) { tries++; try { v3.lz4(body.subarray(0, cut), size); } catch { rejects++; } } for (let k = 0; k < body.length; k += 3) { const c = body.slice(); c[k] ^= 0x55; let rErr = false, zErr = false; try { rust.lz4_decompress_js(c, size); } catch { rErr = true; } try { const out = v3.lz4(c, size); } catch { zErr = true; } tries++; if (rErr === zErr) rejects++; else if (zErr) zigStricter++; else zigLaxer++; } }
console.log(`blocks checked: ${checked}, mismatches: ${bad}; truncation/corruption probes: ${tries}, consistent: ${rejects}, zig rejects where rust accepts: ${zigStricter}, zig accepts where rust rejects: ${zigLaxer}`);

// timing: interleaved, all blocks of a 50k sst, x3 passes per sample
const bl = blocks(rust.encode_sst_js(gen(50000, 11), true));
const t = { rust: [], v3: [], v3s: [] };
for (let r = 0; r < 21; r++) {
  for (const [k, fn] of [["rust", () => { for (const b of bl) rust.lz4_decompress_js(b.body, b.size); }], ["v3", () => { for (const b of bl) v3.lz4Time(b.body, b.size); }], ["v3s", () => { for (const b of bl) v3s.lz4Time(b.body, b.size); }]]) { const a = performance.now(); fn(); t[k].push(performance.now() - a); }
}
const med = (a) => a.sort((x, y) => x - y)[a.length >> 1].toFixed(2);
console.log(`\nlz4 decompress all ${bl.length} blocks (${bl.reduce((s, b) => s + b.size, 0)} B out), interleaved median of 21:\n  rust lz4_flex ${med(t.rust)}   zig ReleaseFast ${med(t.v3)}   zig ReleaseSmall ${med(t.v3s)}  (ms)`);
