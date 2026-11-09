import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const rust = await import(`${ROOT}/packages/kv/wasm/engine_wasm.js`);
await rust.default({ module_or_path: await readFile(`${ROOT}/packages/kv/wasm/engine_wasm_bg.wasm`) });
const { instance } = await WebAssembly.instantiate(await readFile("./engine_fast.wasm"), {});
const ex = instance.exports; const mem = () => new Uint8Array(ex.memory.buffer);
const push = (u8) => { const p = ex.alloc(u8.length); mem().set(u8, p); return p; };
const enc = new TextEncoder();
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function gen(n, seed) { const r = rng(seed), out = []; for (let i = 0; i < n; i++) { const key = enc.encode(`user:${String(Math.floor(r() * n * 3)).padStart(8, "0")}:field${i % 7}`); if (i % 10 === 5) out.push({ kind: "del", key, seq: i + 1 }); else out.push({ kind: "put", key, value: enc.encode(JSON.stringify({ i, name: "name-" + Math.floor(r() * 1000), tags: ["alpha", "beta", i % 3 ? "gamma" : "delta"], pad: "x".repeat(Math.floor(r() * 60)) })), seq: i + 1 }); } return out; }
function flatten(entries) { let n = 0; for (const e of entries) n += 13 + e.key.length + (e.kind === "put" ? 4 + e.value.length : 0); const out = new Uint8Array(n); const dv = new DataView(out.buffer); let o = 0; for (const e of entries) { out[o] = e.kind === "put" ? 1 : 2; dv.setBigUint64(o + 1, BigInt(e.seq), true); dv.setUint32(o + 9, e.key.length, true); o += 13; out.set(e.key, o); o += e.key.length; if (e.kind === "put") { dv.setUint32(o, e.value.length, true); o += 4; out.set(e.value, o); o += e.value.length; } } return out; }
const med = (fn, reps = 15) => { const t = []; for (let i = 0; i < reps; i++) { const a = performance.now(); fn(); t.push(performance.now() - a); } t.sort((x, y) => x - y); return t[reps >> 1].toFixed(2); };
const cmp = (a, b) => { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; };
const big = gen(50000, 11);
const sorted = big.slice().sort((a, b) => cmp(a.key, b.key));
const f1 = flatten(big), f2 = flatten(sorted);
const zenc = (flat, lz4) => { const p = push(flat); ex.encode_sst(p, flat.length, lz4); ex.result_free(); ex.dealloc(p, flat.length); };
console.log("zig encode raw, random order :", med(() => zenc(f1, false)), "ms");
console.log("zig encode raw, pre-sorted   :", med(() => zenc(f2, false)), "ms   (difference = std.mem.sort cost)");
console.log("zig push+dealloc only        :", med(() => { const p = push(f1); ex.dealloc(p, f1.length); }), "ms");
// rust: marshalling cost = encode of 1-entry JS array vs 50k... approximate by timing just the Reflect-free path: not available. Time rust encode total for reference.
console.log("rust encode raw total        :", med(() => rust.encode_sst_js(big, false)), "ms");
console.log("rust encode of pre-sorted    :", med(() => rust.encode_sst_js(sorted, false)), "ms");
// lz4 decompress alone on one block, x2000
const lz = rust.encode_sst_js(big, true); const dv = new DataView(lz.buffer, lz.byteOffset); const footer = lz.length - 44; let o = dv.getUint32(footer + 20, true); const fl = dv.getUint32(o, true); o += 4 + fl; const ll = dv.getUint32(o, true); o += 4 + ll; const off = dv.getUint32(o, true), len = dv.getUint32(o + 4, true);
const blk = lz.slice(off, off + len); const size = new DataView(blk.buffer, blk.byteOffset).getUint32(0, true); const body = blk.subarray(4);
console.log(`block: ${len} B compressed -> ${size} B`);
console.log("rust lz4_decompress x2000    :", med(() => { for (let i = 0; i < 2000; i++) rust.lz4_decompress_js(body, size); }), "ms");
console.log("zig  lz4_decompress x2000    :", med(() => { for (let i = 0; i < 2000; i++) { const p = push(body); ex.lz4_decompress(p, body.length, size); ex.result_free(); ex.dealloc(p, body.length); } }), "ms");
console.log("zig  alloc/free churn x2000  :", med(() => { for (let i = 0; i < 2000; i++) { const p = push(body); ex.dealloc(p, body.length); const q = ex.alloc(size); ex.dealloc(q, size); } }), "ms");
