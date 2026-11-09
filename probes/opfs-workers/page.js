// Orchestrates the OPFS worker probes. Results render in the page and POST to /results.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rootP = navigator.storage.getDirectory();

function browserName() {
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) return "firefox";
  if (/Edg\//.test(ua)) return "edge";
  if (/Chrome\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua)) return "safari";
  return "unknown";
}

function spawn() {
  const w = new Worker("worker.js");
  const events = [];
  const waiters = [];
  w.onmessage = ({ data }) => {
    events.push(data);
    for (const wt of [...waiters]) if (wt.pred(data)) {
      waiters.splice(waiters.indexOf(wt), 1);
      wt.resolve(data);
    }
  };
  w.onerror = (e) => events.push({ ev: "error", error: e.message });
  const next = (pred, timeoutMs = 30000) => {
    const hit = events.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const wt = { pred, resolve };
      waiters.push(wt);
      setTimeout(() => {
        const i = waiters.indexOf(wt);
        if (i >= 0) {
          waiters.splice(i, 1);
          reject(new Error(`timeout after ${timeoutMs} ms; last events ${JSON.stringify(events.slice(-3))}`));
        }
      }, timeoutMs);
    });
  };
  return { w, events, next, run: (op, args) => w.postMessage({ op, ...args }) };
}

async function size(name) {
  const root = await rootP;
  const fh = await root.getFileHandle(name);
  return (await fh.getFile()).size;
}

async function remove(name) {
  const root = await rootP;
  await root.removeEntry(name).catch(() => undefined);
}

async function tryOpenInWorker(file) {
  const t = spawn();
  t.run("tryOpen", { file });
  const r = await t.next((e) => e.ev === "done", 5000).catch((e) => ({ ok: false, error: String(e) }));
  t.w.terminate();
  return r;
}

// Highest write counter stamped in any slot of the P1 file.
async function maxCounter(file, chunkMiB, slots) {
  const root = await rootP;
  const buf = await (await (await root.getFileHandle(file)).getFile()).arrayBuffer();
  const view = new DataView(buf);
  const bytes = chunkMiB << 20;
  let max = 0;
  let torn = 0;
  for (let s = 0; s < slots && (s + 1) * bytes <= buf.byteLength; s++) {
    const head = view.getUint32(s * bytes, true);
    const tail = view.getUint32((s + 1) * bytes - 4, true);
    if (head !== tail) torn++;
    max = Math.max(max, head, tail);
  }
  return { max, torn };
}

// P1 + P2: terminate a worker that is in the middle of sync writes while it holds a Web Lock.
// Fails if any write lands after another context is granted the lock.
async function lockVsLateWrite() {
  const rounds = [];
  for (const chunkMiB of [1, 1, 16, 16, 64, 64]) {
    const slots = Math.max(4, Math.floor(256 / chunkMiB));
    const lock = `iq-p1-${chunkMiB}-${Date.now()}-${rounds.length}`;
    const file = "iq-p1.bin";
    await remove(file);
    const t = spawn();
    t.run("cycleWrite", { lock, file, chunkMiB, slots, maxMs: 10000 });
    await t.next((e) => e.ev === "cycling");
    await sleep(50 + Math.random() * 100);
    const tTerm = performance.now();
    t.w.terminate();
    const grant = await Promise.race([
      navigator.locks.request(lock, async () => {
        const grantedMs = +(performance.now() - tTerm).toFixed(1);
        const atGrant = await maxCounter(file, chunkMiB, slots);
        await sleep(500);
        const later = await maxCounter(file, chunkMiB, slots);
        return { grantedMs, counterAtGrant: atGrant.max, counterLater: later.max, tornSlotsAtGrant: atGrant.torn, lateWrite: later.max > atGrant.max };
      }),
      sleep(10000).then(() => ({ grantedMs: null, note: "lock not released within 10 s of terminate()" })),
    ]);
    const finished = t.events.some((e) => e.ev === "done");
    const reopen = await tryOpenInWorker(file);
    rounds.push({ chunkMiB, ...grant, finishedBeforeTerminate: finished, reopenAfterGrant: reopen.ok, reopenError: reopen.error });
  }
  const late = rounds.filter((r) => r.lateWrite);
  const stuck = rounds.filter((r) => r.grantedMs === null);
  const vacuous = rounds.filter((r) => r.finishedBeforeTerminate);
  return {
    verdict: late.length
      ? `FAIL: ${late.length} of ${rounds.length} rounds had a write land after the lock was released`
      : stuck.length
        ? `FAIL: terminate() did not release the lock in ${stuck.length} rounds`
        : vacuous.length
          ? `inconclusive: ${vacuous.length} rounds finished before terminate()`
          : "ok",
    rounds,
  };
}

// P3: does removeEntry free quota at once?
async function removeFreesQuota() {
  const file = "iq-p3.bin";
  await remove(file);
  const before = (await navigator.storage.estimate()).usage;
  const t = spawn();
  t.run("writeFile", { file, mib: 64 });
  await t.next((e) => e.ev === "done");
  t.w.terminate();
  await sleep(100);
  const written = (await navigator.storage.estimate()).usage;
  const t0 = performance.now();
  await remove(file);
  const samples = [];
  for (let i = 0; i < 20; i++) {
    samples.push({ ms: Math.round(performance.now() - t0), usage: (await navigator.storage.estimate()).usage });
    await sleep(100);
  }
  const grew = written - before;
  const freedAt = samples.find((s) => s.usage <= before + grew / 4);
  return {
    verdict: grew <= 0 ? "inconclusive: estimate() did not count the write" : freedAt ? "ok" : "FAIL: usage not freed within 2 s",
    beforeMiB: +(before / 2 ** 20).toFixed(1),
    writtenMiB: +(written / 2 ** 20).toFixed(1),
    freedAfterMs: freedAt?.ms ?? null,
    samples: samples.slice(0, 5),
  };
}

// P4 + P6: a SharedWorker reads a file another worker keeps appending to.
async function liveRead(frameBytes, perSec = 0) {
  const file = `iq-p4-${frameBytes}.bin`;
  await remove(file);
  const t = spawn();
  const durationMs = 3000;
  t.run("appendLoop", { file, frameBytes, durationMs, flushMs: 100, perSec });
  await t.next((e) => e.ev === "started");
  const sw = new SharedWorker("shared.js", { name: "iq-reader" });
  const result = await new Promise((resolve) => {
    sw.port.onmessage = ({ data }) => resolve(data);
    sw.port.postMessage({ op: "readLoop", file, frameBytes, durationMs: durationMs - 200 });
  });
  const done = await t.next((e) => e.ev === "done", 10000);
  t.w.terminate();
  if (result.error) return { verdict: `error: ${result.error}` };
  const r = result.result;
  return {
    verdict: r.outOfOrder > 0 ? "FAIL: a later whole frame was visible before an earlier one" : r.reads === 0 ? "FAIL: never read" : "ok",
    frameBytes,
    appendsPerSec: Math.round(done.frames / (durationMs / 1000)),
    ...r,
    notReadableRate: +(r.notReadable / Math.max(1, r.reads + r.notReadable)).toFixed(3),
  };
}

// P5: after a SharedWorker closes, is the next `new SharedWorker()` a fresh, responsive instance?
async function sharedWorkerFresh() {
  const ask = (sw, ms = 3000) =>
    Promise.race([
      new Promise((resolve) => {
        sw.port.onmessage = ({ data }) => resolve(data.id);
        sw.port.postMessage({ op: "id" });
      }),
      sleep(ms).then(() => null),
    ]);
  const runs = [];
  for (const delayMs of [0, 50, 500]) {
    const name = `iq-p5-${delayMs}-${Date.now()}`;
    const a = new SharedWorker("shared.js", { name });
    const idA = await ask(a);
    a.port.postMessage({ op: "close" });
    await sleep(delayMs);
    const b = new SharedWorker("shared.js", { name });
    const t0 = performance.now();
    const idB = await ask(b);
    const replyMs = Math.round(performance.now() - t0);
    const retry = idB ? undefined : await ask(new SharedWorker("shared.js", { name }));
    runs.push({ delayMs, idA: !!idA, responded: !!idB, fresh: !!idB && idB !== idA, replyMs, retryResponded: retry === undefined ? undefined : !!retry, retryFresh: retry ? retry !== idA : undefined });
  }
  const bad = runs.filter((r) => !r.fresh);
  return { verdict: bad.length ? `FAIL: ${bad.length} of ${runs.length} reconnects not fresh or silent` : "ok", runs };
}

// P2b + P3b (manual): fill storage to a quota error, then free a reserve and write again.
async function fillQuota(capMiB) {
  const { quota, usage } = await navigator.storage.estimate();
  const freeMiB = (quota - usage) / 2 ** 20;
  if (freeMiB > capMiB) return { verdict: `skipped: ${Math.round(freeMiB)} MiB free is above the ${capMiB} MiB cap` };
  const lock = `iq-fill-${Date.now()}`;
  const t = spawn();
  t.run("fill", { lock, reserveMiB: 8, capMiB });
  try {
    const full = await t.next((e) => e.ev === "full", 600000);
    const flushed = await t.next((e) => e.ev === "flushed", 10000).catch(() => null);
    if (!flushed) {
      const tTerm = performance.now();
      t.w.terminate();
      const grantedMs = await Promise.race([
        navigator.locks.request(lock, () => performance.now() - tTerm),
        sleep(10000).then(() => null),
      ]);
      return { verdict: "flush hung under quota", full, lockReleasedAfterTerminateMs: grantedMs };
    }
    const done = await t.next((e) => e.ev === "done", 10000).catch(() => ({ afterFree: "timeout" }));
    return {
      verdict: typeof done.afterFree === "number" ? "ok: writing again after freeing the reserve" : `FAIL: ${done.afterFree}`,
      full,
      flushed,
      done,
    };
  } finally {
    t.w.terminate();
    await remove("iq-fill.bin");
    await remove("iq-reserve.bin");
  }
}

// P7 (manual): navigate away while a worker holds a lock and a handle; see whether the page is bfcached.
async function bfcacheStart() {
  const lock = `iq-p7-${Date.now()}`;
  const t = spawn();
  t.run("holdForever", { lock, file: "iq-p7.bin" });
  await t.next((e) => e.ev === "holding");
  localStorage.setItem("iq-p7", JSON.stringify({ lock, startedAt: Date.now() }));
  location.href = "away.html";
}

addEventListener("pageshow", (e) => {
  const state = JSON.parse(localStorage.getItem("iq-p7") ?? "null");
  if (!state?.away) return;
  state.bfcached = e.persisted;
  localStorage.setItem("iq-p7", JSON.stringify(state));
  const p7 = {
    verdict: e.persisted ? "page was bfcached" : "page was not bfcached (reloaded)",
    lockHeldWhileAway: state.away.lockHeld,
    handleHeldWhileAway: !state.away.reopen.ok,
    detail: state.away,
  };
  render("P7 bfcache", p7);
  fetch(`/results?browser=${browserName()}-p7`, { method: "POST", body: JSON.stringify({ browser: browserName(), userAgent: navigator.userAgent, at: new Date().toISOString(), results: { "P7 bfcache": p7 } }) });
});

const results = {};
function render(name, value) {
  results[name] = value;
  document.getElementById("out").textContent = JSON.stringify({ browser: browserName(), userAgent: navigator.userAgent, results }, null, 2);
}

async function step(name, fn) {
  render(name, { verdict: "running…" });
  console.log(`probe: ${name} started`);
  try {
    render(name, await fn());
  } catch (err) {
    render(name, { verdict: `error: ${err.name}: ${err.message}` });
  }
  console.log(`probe: ${name} -> ${results[name].verdict}`);
}

async function runAll() {
  await step("P1+P2 lock vs late write", lockVsLateWrite);
  await step("P3 removeEntry frees quota", removeFreesQuota);
  await step("P4+P6 live read, 128 B frames, unpaced", () => liveRead(128));
  await step("P4+P6 live read, 128 B frames, 10k/s", () => liveRead(128, 10000));
  await step("P4+P6 live read, 128 B frames, 1k/s", () => liveRead(128, 1000));
  await step("P4+P6 live read, 128 B frames, 100/s", () => liveRead(128, 100));
  await step("P4+P6 live read, 4 KiB frames, unpaced", () => liveRead(4096));
  await step("P5 SharedWorker reconnect", sharedWorkerFresh);
  for (const f of ["iq-p1.bin", "iq-p4-128.bin", "iq-p4-4096.bin"]) await remove(f);
  await fetch(`/results?browser=${browserName()}`, { method: "POST", body: JSON.stringify({ browser: browserName(), userAgent: navigator.userAgent, at: new Date().toISOString(), results }) });
  document.getElementById("status").textContent = "done, results posted";
}

document.getElementById("all").onclick = runAll;
document.getElementById("fill").onclick = () => step("P2b+P3b fill quota", () => fillQuota(Number(document.getElementById("cap").value)));
document.getElementById("bfcache").onclick = bfcacheStart;
if (new URLSearchParams(location.search).has("auto")) runAll();
