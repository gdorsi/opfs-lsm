const PAGE = 32 * 1024;
const PAGES = 512;
const FILE_BYTES = PAGE * PAGES;
const DATA_AT = 64;
const DATA_BYTES = 1 << 20;
const WAKE = 0, DONE = 1, REQ = 2, FILE = 3, OFF_LO = 4, OFF_HI = 5, LEN = 6, STATUS = 7, MODE = 8;
const K = 2654435761;
const DIR = "sab-probe";
const SMALL_FILES = 64;

const out = document.getElementById("out");
const log = (line) => (out.textContent += `\n${line}`);

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(n, rand) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const wordAt = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

function intact(bytes, off, len) {
  if (!bytes || bytes.byteLength !== len) return false;
  const first = Math.imul(off / 4, K) >>> 0;
  const last = Math.imul((off + len) / 4 - 1, K) >>> 0;
  return wordAt(bytes, 0) === first && wordAt(bytes, len - 4) === last;
}

function summary(samples) {
  const s = Float64Array.from(samples).sort();
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  let sum = 0;
  for (const v of s) sum += v;
  const us = (ms) => Math.round(ms * 10000) / 10;
  return { n: s.length, mean: us(sum / s.length), p50: us(at(0.5)), p90: us(at(0.9)), p99: us(at(0.99)), max: us(s[s.length - 1]) };
}

async function setup() {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(DIR, { recursive: true }).catch(() => undefined);
  const dir = await root.getDirectoryHandle(DIR, { create: true });
  const words = new Uint32Array(FILE_BYTES / 4);
  for (let i = 0; i < words.length; i++) words[i] = Math.imul(i, K);
  const names = ["run.bin"];
  const write = async (name, bytes) => {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
    return fh;
  };
  const fh = await write("run.bin", words.buffer);
  for (let i = 0; i < SMALL_FILES; i++) {
    names.push(`small-${i}.bin`);
    await write(`small-${i}.bin`, new Uint8Array(words.buffer, 0, 64 * 1024));
  }
  return { dir, file: await fh.getFile(), smallNames: names.slice(1) };
}

function startWorker() {
  const t0 = performance.now();
  const worker = new Worker("worker.js");
  const waiting = new Map();
  let nextId = 0;
  let onFlag;
  const flag = () => new Promise((r) => (onFlag = r));
  worker.onmessage = ({ data: m }) => {
    if (m.id !== undefined) {
      waiting.get(m.id)(m);
      waiting.delete(m.id);
    } else onFlag?.(m);
  };
  const call = (msg) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      worker.postMessage({ ...msg, id });
    });
  return {
    t0,
    flag,
    call,
    post: (m) => worker.postMessage(m),
    msgRead: async (off, len) => new Uint8Array((await call({ cmd: "read", file: 0, off, len })).buf),
  };
}

export async function runProbe({ rounds = 8, seed = 1 } = {}) {
  if (!crossOriginIsolated) throw new Error("not cross-origin isolated");
  const { dir, file, smallNames } = await setup();
  const sab = new SharedArrayBuffer(DATA_AT + DATA_BYTES);
  const ctl = new Int32Array(sab, 0, 16);
  const data = new Uint8Array(sab, DATA_AT);

  const w = startWorker();
  const up = w.flag();
  await up;
  const upMs = performance.now() - w.t0;
  const readyFlag = w.flag();
  w.post({ cmd: "init", sab, dir: DIR, files: ["run.bin"] });
  const ready = await readyFlag;
  const readyMs = performance.now() - w.t0;

  let reqId = 0;
  function request(off, len) {
    ctl[FILE] = 0;
    ctl[OFF_LO] = off >>> 0;
    ctl[OFF_HI] = Math.floor(off / 4294967296);
    ctl[LEN] = len;
    const id = ++reqId;
    Atomics.store(ctl, REQ, id);
    Atomics.add(ctl, WAKE, 1);
    Atomics.notify(ctl, WAKE);
    return id;
  }
  let maxSpins = 0;
  function sabSpin(off, len) {
    const id = request(off, len);
    let spins = 0;
    while (Atomics.load(ctl, DONE) !== id) {
      if (++spins > 2e9) throw new Error("worker never answered");
    }
    if (spins > maxSpins) maxSpins = spins;
    return data.slice(0, ctl[STATUS]);
  }
  async function sabAwait(off, len) {
    const id = request(off, len);
    for (;;) {
      const d = Atomics.load(ctl, DONE);
      if (d === id) break;
      const r = Atomics.waitAsync(ctl, DONE, d);
      if (r.async) await r.value;
    }
    return data.slice(0, ctl[STATUS]);
  }
  const asyncSlice = async (off, len) => new Uint8Array(await file.slice(off, off + len).arrayBuffer());

  let blocking = false;
  async function workerMode(mode, spin = 0) {
    if (blocking) {
      const f = w.flag();
      Atomics.store(ctl, MODE, 1);
      Atomics.add(ctl, WAKE, 1);
      Atomics.notify(ctl, WAKE);
      await f;
      blocking = false;
    }
    ctl[9] = mode === "loop" ? spin : 0;
    if (mode === "block") {
      const f = w.flag();
      w.post({ cmd: "block", spin });
      await f;
      blocking = true;
    }
  }

  const SPIN = 200_000;
  const variants = [
    { name: "async slice (today)", worker: "loop", read: asyncSlice },
    { name: "worker, postMessage + transfer", worker: "loop", read: w.msgRead },
    { name: "sab: main awaits, worker waitAsync", worker: "loop", read: sabAwait },
    { name: "sab: main spins, worker waitAsync", worker: "loop", read: sabSpin },
    { name: "sab: main awaits, worker blocks", worker: "block", read: sabAwait },
    { name: "sab: main spins, worker blocks", worker: "block", read: sabSpin },
    { name: "sab: main spins, worker blocks + spins", worker: "block", spin: SPIN, read: sabSpin },
    { name: "sab: main spins, worker waitAsync + spins 200k", worker: "loop", spin: SPIN, read: sabSpin },
    { name: "sab: main spins, worker waitAsync + spins 20k", worker: "loop", spin: 20_000, read: sabSpin },
    { name: "sab: main spins, worker waitAsync + spins 2k", worker: "loop", spin: 2_000, read: sabSpin },
    { name: "control: message round trip, no read", worker: "loop", read: async () => void (await w.call({ cmd: "noop" })), noCheck: true },
    { name: "control: sab round trip, no read", worker: "block", read: (off) => sabSpin(off, 0), noCheck: true },
    { name: "control: sab round trip, no read, worker spins", worker: "block", spin: SPIN, read: (off) => sabSpin(off, 0), noCheck: true },
  ];
  const perRead = variants.map(() => []);
  const totals = variants.map(() => []);
  const errors = variants.map(() => 0);

  const batchVariants = [
    { name: "async slice, 450 at once", worker: "loop", run: (offs) => Promise.all(offs.map((o) => asyncSlice(o, PAGE))) },
    { name: "async slice, coalesced spans", worker: "loop", run: (offs) => coalesced(offs) },
    { name: "worker, postMessage, 450 at once", worker: "loop", run: (offs) => Promise.all(offs.map((o) => w.msgRead(o, PAGE))) },
    { name: "sab: main spins, worker blocks", worker: "block", run: (offs) => offs.map((o) => sabSpin(o, PAGE)) },
    { name: "sab: main spins, worker blocks + spins", worker: "block", spin: SPIN, run: (offs) => offs.map((o) => sabSpin(o, PAGE)) },
    { name: "sab: main spins, worker waitAsync + spins 20k", worker: "loop", spin: 20_000, run: (offs) => offs.map((o) => sabSpin(o, PAGE)) },
  ];
  const batchMs = batchVariants.map(() => []);
  const batchErrors = batchVariants.map(() => 0);

  async function coalesced(offs) {
    const sorted = [...offs].sort((a, b) => a - b);
    const spans = [];
    for (const o of sorted) {
      const last = spans[spans.length - 1];
      if (last && o - last.end <= 128 * 1024 && o + PAGE - last.start <= 1 << 20) {
        last.end = o + PAGE;
        last.pages.push(o);
      } else spans.push({ start: o, end: o + PAGE, pages: [o] });
    }
    const byOffset = new Map();
    await Promise.all(
      spans.map(async (s) => {
        const buf = new Uint8Array(await file.slice(s.start, s.end).arrayBuffer());
        for (const o of s.pages) byOffset.set(o, buf.slice(o - s.start, o - s.start + PAGE));
      }),
    );
    return offs.map((o) => byOffset.get(o));
  }

  const rand = rng(seed);
  for (let round = 0; round < rounds; round++) {
    const offsets = shuffled(PAGES, rand).map((p) => p * PAGE);
    for (let k = 0; k < variants.length; k++) {
      const vi = (k + round) % variants.length;
      const v = variants[vi];
      await workerMode(v.worker, v.spin);
      const t0 = performance.now();
      for (const off of offsets) {
        const a = performance.now();
        let bytes = v.read(off, PAGE);
        if (bytes instanceof Promise) bytes = await bytes;
        perRead[vi].push(performance.now() - a);
        if (!v.noCheck && !intact(bytes, off, PAGE)) errors[vi]++;
      }
      totals[vi].push(performance.now() - t0);
    }
    const some = shuffled(PAGES, rand).slice(0, 450).map((p) => p * PAGE);
    for (let k = 0; k < batchVariants.length; k++) {
      const bi = (k + round) % batchVariants.length;
      const b = batchVariants[bi];
      await workerMode(b.worker, b.spin);
      const t0 = performance.now();
      const pages = await b.run(some);
      batchMs[bi].push(performance.now() - t0);
      pages.forEach((bytes, i) => {
        if (!intact(bytes, some[i], PAGE)) batchErrors[bi]++;
      });
    }
    log(`round ${round + 1}/${rounds}`);
  }

  const sizes = [];
  for (const len of [4 * 1024, 32 * 1024, 256 * 1024, 1 << 20]) {
    const count = 64;
    const offs = Array.from({ length: count }, () => Math.floor(rand() * ((FILE_BYTES - len) / PAGE)) * PAGE);
    const row = { bytes: len };
    for (const [label, mode, spin, read] of [
      ["asyncSlice", "loop", 0, asyncSlice],
      ["sabSpin", "block", SPIN, sabSpin],
    ]) {
      await workerMode(mode, spin);
      let bad = 0;
      const per = [];
      for (let rep = 0; rep < 4; rep++) {
        for (const off of offs) {
          const a = performance.now();
          let bytes = read(off, len);
          if (bytes instanceof Promise) bytes = await bytes;
          per.push(performance.now() - a);
          if (!intact(bytes, off, len)) bad++;
        }
      }
      row[label] = { ...summary(per), errors: bad };
    }
    sizes.push(row);
  }
  await workerMode("loop");

  const opens = {};
  for (const parallel of [false, true]) {
    const mainMs = [];
    const workerMs = [];
    const workerCloseMs = [];
    for (let rep = 0; rep < 5; rep++) {
      const t0 = performance.now();
      const one = async (name) => (await dir.getFileHandle(name)).getFile();
      if (parallel) await Promise.all(smallNames.map(one));
      else for (const name of smallNames) await one(name);
      mainMs.push((performance.now() - t0) / smallNames.length);
      const r = await w.call({ cmd: "openMany", names: smallNames, parallel });
      workerMs.push(r.ms / smallNames.length);
      workerCloseMs.push(r.closeMs / smallNames.length);
    }
    opens[parallel ? "parallel" : "serial"] = {
      mainGetFile: summary(mainMs),
      workerSyncHandle: summary(workerMs),
      workerClose: summary(workerCloseMs),
    };
  }

  const spinMs = (await w.call({ cmd: "calibrate", spin: SPIN })).ms;
  const copyT0 = performance.now();
  let copied = 0;
  for (let i = 0; i < 4096; i++) copied += data.slice(0, PAGE).byteLength;
  const copyUs = ((performance.now() - copyT0) / 4096) * 1000;

  const result = {
    userAgent: navigator.userAgent,
    workerSpinMs: +spinMs.toFixed(3),
    copyOutUs: +copyUs.toFixed(2),
    copied,
    sharedRead: ready.sharedRead,
    featureCheck: { modeOnPrototype: ready.modeOnPrototype, handleMode: ready.handleMode, waitAsync: ready.waitAsync, crossOriginIsolated },
    workerStartMs: { scriptUp: +upMs.toFixed(2), handleOpen: +readyMs.toFixed(2) },
    maxSpins,
    rounds,
    perRead: variants.map((v, i) => ({
      name: v.name,
      ...summary(perRead[i]),
      meanFromTotals: Math.round((totals[i].reduce((a, b) => a + b, 0) / (rounds * PAGES)) * 10000) / 10,
      errors: errors[i],
    })),
    batch450: batchVariants.map((b, i) => ({
      name: b.name,
      medianMs: +[...batchMs[i]].sort((x, y) => x - y)[Math.floor(rounds / 2)].toFixed(2),
      minMs: +Math.min(...batchMs[i]).toFixed(2),
      maxMs: +Math.max(...batchMs[i]).toFixed(2),
      errors: batchErrors[i],
    })),
    sizes,
    opens,
  };
  log(JSON.stringify(result, null, 2));
  return result;
}

globalThis.runProbe = runProbe;
if (new URLSearchParams(location.search).has("auto")) runProbe();
