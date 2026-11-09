// SharedWorker: reports its instance id and reads a growing file the way ingest would.
const instance = crypto.randomUUID();
const startedAt = Date.now();

function validFrame(view, at, frameBytes, n) {
  if (at + frameBytes > view.byteLength) return false;
  if (view.getUint32(at, true) !== n) return false;
  if (view.getUint32(at + 4, true) !== frameBytes) return false;
  if (view.getUint32(at + frameBytes - 4, true) !== n) return false;
  const fill = n & 0xff;
  for (let i = at + 8; i < at + frameBytes - 4; i += 61) if (view.getUint8(i) !== fill) return false;
  return true;
}

// Number of whole frames from the start, and whether any whole later frame follows a gap.
function scan(buffer, frameBytes) {
  const view = new DataView(buffer);
  let n = 0;
  while (validFrame(view, n * frameBytes, frameBytes, n + 1)) n++;
  let outOfOrder = false;
  for (let k = n + 1; (k + 1) * frameBytes <= view.byteLength; k++) {
    if (validFrame(view, k * frameBytes, frameBytes, k + 1)) {
      outOfOrder = true;
      break;
    }
  }
  return { frames: n, bytes: view.byteLength, outOfOrder };
}

async function readLoop({ file, frameBytes, durationMs }) {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(file);
  const out = {
    reads: 0,
    notReadable: 0,
    otherErrors: [],
    longestFailStreak: 0,
    longestNoReadMs: 0,
    outOfOrder: 0,
    regressed: 0,
    sizeMismatch: 0,
    lastFrames: 0,
  };
  let streak = 0;
  let lastOk = performance.now();
  let prevFrames = 0;
  const end = performance.now() + durationMs;
  while (performance.now() < end) {
    try {
      const f = await fh.getFile();
      const buf = await f.arrayBuffer();
      if (buf.byteLength !== f.size) out.sizeMismatch++;
      const s = scan(buf, frameBytes);
      out.reads++;
      if (s.outOfOrder) out.outOfOrder++;
      if (s.frames < prevFrames) out.regressed++;
      prevFrames = Math.max(prevFrames, s.frames);
      out.lastFrames = s.frames;
      streak = 0;
      lastOk = performance.now();
    } catch (err) {
      if (err.name === "NotReadableError") out.notReadable++;
      else if (out.otherErrors.length < 5) out.otherErrors.push(`${err.name}: ${err.message}`);
      streak++;
      out.longestFailStreak = Math.max(out.longestFailStreak, streak);
      out.longestNoReadMs = Math.max(out.longestNoReadMs, performance.now() - lastOk);
    }
  }
  return out;
}

onconnect = (e) => {
  const port = e.ports[0];
  port.onmessage = async ({ data }) => {
    if (data.op === "id") port.postMessage({ id: instance, startedAt });
    else if (data.op === "close") self.close();
    else if (data.op === "readLoop") {
      try {
        port.postMessage({ result: await readLoop(data) });
      } catch (err) {
        port.postMessage({ error: `${err.name}: ${err.message}` });
      }
    }
  };
};
