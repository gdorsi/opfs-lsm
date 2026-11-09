// Dedicated WebWorker: holds Web Locks and SyncAccessHandles for the probes.
const rootP = navigator.storage.getDirectory();

async function open(name) {
  const root = await rootP;
  const fh = await root.getFileHandle(name, { create: true });
  return fh.createSyncAccessHandle();
}

function frame(n, bytes) {
  const buf = new Uint8Array(bytes);
  const view = new DataView(buf.buffer);
  view.setUint32(0, n, true);
  buf.fill(n & 0xff, 8, bytes - 4);
  view.setUint32(4, bytes, true);
  view.setUint32(bytes - 4, n, true);
  return buf;
}

const ops = {
  // Hold `lock` and overwrite `slots` chunks round-robin for up to `maxMs`, each chunk stamped
  // with its write counter, so a write is always in flight when the worker is terminated.
  async cycleWrite({ lock, file, chunkMiB, slots, maxMs }) {
    await navigator.locks.request(lock, async () => {
      const sah = await open(file);
      sah.truncate(0);
      const bytes = chunkMiB << 20;
      const buf = new Uint8Array(bytes);
      const view = new DataView(buf.buffer);
      const end = performance.now() + maxMs;
      postMessage({ ev: "holding" });
      let i = 0;
      while (performance.now() < end) {
        i++;
        view.setUint32(0, i, true);
        view.setUint32(bytes - 4, i, true);
        sah.write(buf, { at: (i % slots) * bytes });
        if (i === 3) postMessage({ ev: "cycling" });
      }
      sah.close();
      postMessage({ ev: "done", writes: i });
    });
  },

  // Append fixed-size frames for `durationMs`, at most `perSec` per second (0 = unpaced),
  // flushing every `flushMs`.
  async appendLoop({ file, frameBytes, durationMs, flushMs, perSec = 0 }) {
    const sah = await open(file);
    sah.truncate(0);
    postMessage({ ev: "started" });
    const start = performance.now();
    const end = start + durationMs;
    let n = 0;
    let at = 0;
    let lastFlush = performance.now();
    while (performance.now() < end) {
      if (perSec > 0) while (performance.now() < start + (n * 1000) / perSec);
      n++;
      at += sah.write(frame(n, frameBytes), { at });
      if (performance.now() - lastFlush >= flushMs) {
        sah.flush();
        lastFlush = performance.now();
      }
    }
    sah.flush();
    sah.close();
    postMessage({ ev: "done", frames: n, bytes: at });
  },

  // Write `mib` MiB through a handle, flush, close.
  async writeFile({ file, mib }) {
    const sah = await open(file);
    sah.truncate(0);
    const buf = new Uint8Array(1 << 20).fill(7);
    for (let i = 0; i < mib; i++) sah.write(buf, { at: i << 20 });
    sah.flush();
    sah.close();
    postMessage({ ev: "done" });
  },

  // Try to open a handle on `file`; report whether it worked.
  async tryOpen({ file }) {
    try {
      const sah = await open(file);
      sah.close();
      postMessage({ ev: "done", ok: true });
    } catch (err) {
      postMessage({ ev: "done", ok: false, error: `${err.name}: ${err.message}` });
    }
  },

  // Fill storage until a quota error, then test freeing a reserve file.
  async fill({ lock, reserveMiB, capMiB }) {
    await navigator.locks.request(lock, async () => {
      const root = await rootP;
      const reserve = await open("iq-reserve.bin");
      const mib = new Uint8Array(1 << 20).fill(3);
      for (let i = 0; i < reserveMiB; i++) reserve.write(mib, { at: i << 20 });
      reserve.flush();
      reserve.close();
      const sah = await open("iq-fill.bin");
      sah.truncate(0);
      const chunk = new Uint8Array(16 << 20).fill(5);
      let at = 0;
      let error;
      postMessage({ ev: "filling" });
      while (at < capMiB << 20) {
        try {
          const wrote = sah.write(chunk, { at });
          at += wrote;
          if (wrote < chunk.byteLength) {
            error = `short write ${wrote}`;
            break;
          }
        } catch (err) {
          error = `${err.name}: ${err.message}`;
          break;
        }
        if ((at / (16 << 20)) % 8 === 0) postMessage({ ev: "progress", at });
      }
      postMessage({ ev: "full", at, error });
      if (!error) {
        sah.close();
        postMessage({ ev: "done", reachedCap: true });
        return;
      }
      postMessage({ ev: "flushing" });
      let flushError;
      try {
        sah.flush();
      } catch (err) {
        flushError = `${err.name}: ${err.message}`;
      }
      postMessage({ ev: "flushed", flushError });
      await root.removeEntry("iq-reserve.bin");
      let afterFree;
      try {
        afterFree = sah.write(mib, { at });
        sah.flush();
      } catch (err) {
        afterFree = `${err.name}: ${err.message}`;
      }
      sah.close();
      postMessage({ ev: "done", afterFree });
    });
  },

  // Hold a lock and a handle until terminated.
  async holdForever({ lock, file }) {
    navigator.locks.request(lock, async () => {
      const sah = await open(file);
      postMessage({ ev: "holding" });
      await new Promise(() => {});
      sah.close();
    });
  },

  ping() {
    postMessage({ ev: "pong" });
  },
};

onmessage = async ({ data }) => {
  try {
    await ops[data.op](data);
  } catch (err) {
    postMessage({ ev: "error", error: `${err.name}: ${err.message}` });
  }
};
