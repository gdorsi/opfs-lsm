const WAKE = 0, DONE = 1, REQ = 2, FILE = 3, OFF_LO = 4, OFF_HI = 5, LEN = 6, STATUS = 7, MODE = 8;
const DATA_AT = 64;

let ctl, data, dir;
let served = 0;
const handles = [];

function serve() {
  const id = Atomics.load(ctl, REQ);
  if (id === served) return;
  const len = ctl[LEN];
  let n = 0;
  if (len > 0) {
    const at = (ctl[OFF_LO] >>> 0) + ctl[OFF_HI] * 4294967296;
    try {
      n = handles[ctl[FILE]].read(data.subarray(0, len), { at });
    } catch {
      n = -1;
    }
  }
  ctl[STATUS] = n;
  served = id;
  Atomics.store(ctl, DONE, id);
  Atomics.notify(ctl, DONE);
}

async function asyncLoop() {
  for (;;) {
    let w = Atomics.load(ctl, WAKE);
    serve();
    const spin = ctl[9];
    for (let i = 0; i < spin; i++) {
      const now = Atomics.load(ctl, WAKE);
      if (now !== w) {
        w = now;
        serve();
        i = 0;
      }
    }
    const r = Atomics.waitAsync(ctl, WAKE, w);
    if (r.async) await r.value;
  }
}

function block(spin) {
  for (;;) {
    const w = Atomics.load(ctl, WAKE);
    serve();
    if (Atomics.load(ctl, MODE) === 1) return;
    let woke = false;
    for (let i = 0; i < spin; i++) {
      if (Atomics.load(ctl, WAKE) !== w) {
        woke = true;
        break;
      }
    }
    if (!woke) Atomics.wait(ctl, WAKE, w);
  }
}

async function openHandle(name) {
  const fh = await dir.getFileHandle(name);
  return fh.createSyncAccessHandle({ mode: "read-only" });
}

postMessage({ up: true });

onmessage = async ({ data: m }) => {
  switch (m.cmd) {
    case "init": {
      ctl = new Int32Array(m.sab, 0, 16);
      data = new Uint8Array(m.sab, DATA_AT);
      dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(m.dir);
      let sharedRead = true;
      for (const name of m.files) handles.push(await openHandle(name));
      try {
        handles[0].read(data.subarray(0, 16), { at: 0 });
      } catch (err) {
        sharedRead = String(err);
      }
      asyncLoop();
      postMessage({
        ready: true,
        sharedRead,
        sizes: handles.map((h) => h.getSize()),
        modeOnPrototype: "mode" in FileSystemSyncAccessHandle.prototype,
        handleMode: handles[0].mode,
        waitAsync: typeof Atomics.waitAsync,
      });
      break;
    }
    case "block":
      Atomics.store(ctl, MODE, 0);
      postMessage({ blocked: true });
      block(m.spin);
      postMessage({ unblocked: true });
      break;
    case "read": {
      const buf = new Uint8Array(m.len);
      handles[m.file].read(buf, { at: m.off });
      postMessage({ id: m.id, buf: buf.buffer }, [buf.buffer]);
      break;
    }
    case "calibrate": {
      const t0 = performance.now();
      let hits = 0;
      for (let i = 0; i < m.spin; i++) if (Atomics.load(ctl, WAKE) === -1) hits++;
      postMessage({ id: m.id, ms: performance.now() - t0, hits });
      break;
    }
    case "noop":
      postMessage({ id: m.id });
      break;
    case "openMany": {
      const t0 = performance.now();
      const opened = [];
      if (m.parallel) opened.push(...(await Promise.all(m.names.map(openHandle))));
      else for (const name of m.names) opened.push(await openHandle(name));
      const ms = performance.now() - t0;
      const t1 = performance.now();
      for (const h of opened) h.close();
      postMessage({ id: m.id, ms, closeMs: performance.now() - t1 });
      break;
    }
  }
};
