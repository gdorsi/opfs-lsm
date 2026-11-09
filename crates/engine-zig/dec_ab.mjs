import { performance } from "node:perf_hooks";
import { loadZig, loadRust, genEntries as gen, flatten, framedBlocks, eq } from "./loader.mjs";

const rust = await loadRust();
const v3 = await loadZig("./engine_fast.wasm"), v3s = await loadZig("./engine_small.wasm");
const enc = new TextEncoder();
const blocks = (sst) => framedBlocks(sst).map((blk) => ({ body: blk.subarray(4), size: new DataView(blk.buffer, blk.byteOffset).getUint32(0, true) }));
// Writes the input and decodes without copying the result out, so the timing is the decoder.
const lz4Time = (z, src, size) => { const p = z.ex.input_ptr(src.length); new Uint8Array(z.ex.memory.buffer).set(src, p); z.ex.lz4_decompress(p, src.length, size); };

// correctness across every block of realistic data (Rust- and Zig-compressed) and pathological values
let checked = 0, bad = 0;
const sets = [["realistic/rust-compressed", rust.encodeEntries(gen(30000, 5), true)], ["realistic/zig-compressed", v3.encode(flatten(gen(30000, 5)), true)]];
const patho = []; const pats = ["a", "ab", "abc", "abcd", "abcde", "abcdef", "abcdefg", "abcdefgh", "0123456789abcdef", "xy"];
for (let i = 0; i < 4000; i++) { const p = pats[i % pats.length]; patho.push({ kind: "put", key: enc.encode("k" + String(i).padStart(5, "0")), value: enc.encode(p.repeat(1 + (i * 7) % 40) + (i % 3 ? "" : "tail")), seq: i }); }
sets.push(["periodic/zig-compressed", v3.encode(flatten(patho), true)], ["periodic/rust-compressed", rust.encodeEntries(patho, true)]);
for (const [name, sst] of sets) { let n = 0; for (const { body, size } of blocks(sst)) { const r = rust.lz4(body, size); for (const z of [v3, v3s]) { checked++; if (!eq(r, z.lz4(body, size))) { bad++; console.log("MISMATCH", name, "block", n); } } n++; } console.log(`${name}: ${n} blocks`); }
// truncated / corrupted inputs must error, not crash
let rejects = 0, tries = 0, zigStricter = 0, zigLaxer = 0; { const { body, size } = blocks(sets[0][1])[3]; for (let cut = 0; cut < body.length; cut += 7) { tries++; try { v3.lz4(body.subarray(0, cut), size); } catch { rejects++; } } for (let k = 0; k < body.length; k += 3) { const c = body.slice(); c[k] ^= 0x55; let rErr = false, zErr = false; try { rust.lz4(c, size); } catch { rErr = true; } try { v3.lz4(c, size); } catch { zErr = true; } tries++; if (rErr === zErr) rejects++; else if (zErr) zigStricter++; else zigLaxer++; } }
console.log(`blocks checked: ${checked}, mismatches: ${bad}; truncation/corruption probes: ${tries}, consistent: ${rejects}, zig rejects where rust accepts: ${zigStricter}, zig accepts where rust rejects: ${zigLaxer}`);

// timing: interleaved, all blocks of a 50k sst, x3 passes per sample
const bl = blocks(rust.encodeEntries(gen(50000, 11), true));
const t = { rust: [], v3: [], v3s: [] };
for (let r = 0; r < 21; r++) {
  for (const [k, fn] of [["rust", rust.abi === "flat" ? () => { for (const b of bl) lz4Time(rust, b.body, b.size); } : () => { for (const b of bl) rust.lz4(b.body, b.size); }], ["v3", () => { for (const b of bl) lz4Time(v3, b.body, b.size); }], ["v3s", () => { for (const b of bl) lz4Time(v3s, b.body, b.size); }]]) { const a = performance.now(); fn(); t[k].push(performance.now() - a); }
}
const med = (a) => a.sort((x, y) => x - y)[a.length >> 1].toFixed(2);
console.log(`\nlz4 decompress all ${bl.length} blocks (${bl.reduce((s, b) => s + b.size, 0)} B out), interleaved median of 21:\n  rust (${rust.abi}) ${med(t.rust)}   zig ReleaseFast ${med(t.v3)}   zig ReleaseSmall ${med(t.v3s)}  (ms)`);
for (const e of [v3, v3s, rust]) { const m = e.memory(); if (m) console.log(`${e.name} memory: ${m.calls} calls, grew during ${m.growths}`); }
