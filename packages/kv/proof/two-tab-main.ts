/**
 * Tab A puts, warms SST readers, and must still get the key after tab B ingests.
 * Then tab A range-deletes rows, some flushed and some not, and tab B must
 * read them as absent before and after it ingests.
 *
 *   ?auto=1&role=a     leader tab
 *   ?auto=1&role=b     peer tab
 *   ?local=1           one page, two handles, one EngineHost
 *   ?nobc=1            drop BroadcastChannel messages before openDb
 */
const params = new URLSearchParams(location.search);
const ROLE = params.get("role");
const LOCAL = params.has("local");
const NOBC = params.has("nobc");
const AUTO = params.has("auto");
const DB_NAME = params.get("name") ?? "two-tab";

const statusEl = document.getElementById("status")!;
const out = document.getElementById("out")!;
const runBtn = document.getElementById("run") as HTMLButtonElement;

let bcPosts = 0;

if (NOBC) {
  class SilentChannel {
    constructor(_name: string) {}
    postMessage(_data: unknown): void {
      bcPosts += 1;
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    close(): void {}
  }
  Object.defineProperty(globalThis, "BroadcastChannel", {
    configurable: true,
    writable: true,
    value: SilentChannel,
  });
}

const maxWalBytes = 1 << 30;
const enc = new TextEncoder();
const dec = new TextDecoder();

type Handle = {
  put(key: Uint8Array, value: Uint8Array): Promise<unknown>;
  batch(
    body: (tx: {
      deleteRange(bounds: { start?: Uint8Array; endExclusive?: Uint8Array }): void;
    }) => void,
  ): Promise<unknown>;
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  ingest(): Promise<{ generation: number }>;
  range(): AsyncIterable<{ key: Uint8Array; value: Uint8Array }>;
  view<T>(
    body: (snap: {
      get(key: Uint8Array): Promise<Uint8Array | undefined>;
    }) => Promise<T>,
  ): Promise<T>;
  sync(): Promise<void>;
  close(): Promise<void>;
};

type OtherTab = {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  ingest(): Promise<number>;
};

type PeerCmd =
  | { id: number; op: "put"; key: string; value: string }
  | { id: number; op: "get"; key: string }
  | { id: number; op: "ingest" };

type PeerResult = {
  id: number;
  ok: boolean;
  value: string | null;
  generation: number | null;
  error: string | null;
};

function log(line: string): void {
  out.textContent += line + "\n";
}

function text(bytes: Uint8Array | undefined): string | null {
  if (!bytes) return null;
  return dec.decode(bytes);
}

function must(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

let reported = false;

async function report(payload: { error?: string; log: string }): Promise<void> {
  if (!AUTO || reported) return;
  reported = true;
  try {
    await fetch("/two-tab-results", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("report failed", err);
  }
}

function modeLabel(): string {
  const base = LOCAL ? "local EngineHost" : "SharedWorker";
  return NOBC ? `${base} nobc` : base;
}

async function openHandle(
  mod: typeof import("../dist/index.js"),
  testing: typeof import("../dist/testing.js"),
  writerId: string,
  shared?: {
    fs: Awaited<ReturnType<typeof testing.openBrowserFs>>;
    ingest: ReturnType<typeof testing.createLocalIngestClient>;
  },
): Promise<Handle> {
  const db = await testing.openHarnessDb({
    name: DB_NAME,
    writerId,
    maxWalBytes,
    ...(shared ? { fs: shared.fs, ingest: shared.ingest } : {}),
  });
  return Object.assign(db, { ingest: () => testing.ingest(db) });
}

async function scenario(self: Handle, other: OtherTab): Promise<void> {
  const t0 = performance.now();
  log(`mode=${modeLabel()}`);
  log(
    `OPFS=${!!navigator.storage?.getDirectory}  SharedWorker=${typeof SharedWorker !== "undefined"}`,
  );

  await self.put(enc.encode("seed"), enc.encode("s"));
  const seeded = await self.ingest();
  const seed = text(await self.get(enc.encode("seed")));
  must(seed === "s", `warm get seed was ${seed}`);
  must(seeded.generation >= 1, "seed ingest did not publish a generation");
  log(`warm seed generation=${seeded.generation}`);

  await other.put("k", "v");
  await self.sync();

  const pin = await self.view(async (snap) => {
    const before = text(await snap.get(enc.encode("k")));
    const ingested = await other.ingest();
    const after = text(await snap.get(enc.encode("k")));
    return { before, after, generation: seeded.generation, ingested };
  });
  must(pin.before === "v", `pinned get before ingest was ${pin.before}`);
  must(pin.after === "v", `pinned get after ingest was ${pin.after}`);
  must(
    pin.ingested > pin.generation,
    `ingest generation ${pin.ingested} did not pass pinned ${pin.generation}`,
  );
  log(
    `pinned generation=${pin.generation} ingest generation=${pin.ingested}`,
  );

  const fresh = text(await self.get(enc.encode("k")));
  must(fresh === "v", `fresh get after ingest was ${fresh}`);
  log("fresh k=v");

  let ranged = false;
  for await (const entry of self.range()) {
    if (text(entry.key) === "k" && text(entry.value) === "v") ranged = true;
  }
  must(ranged, "range missed k after ingest");
  log("range has k");

  await self.put(enc.encode("after"), enc.encode("yes"));
  const seen = await other.get("after");
  must(seen === "yes", `other tab get after ingest was ${seen}`);
  log("other tab saw after=yes");

  await self.put(enc.encode("gone/1"), enc.encode("x"));
  await self.ingest();
  await self.put(enc.encode("gone/2"), enc.encode("x"));
  await self.put(enc.encode("gone0"), enc.encode("kept"));
  must((await other.get("gone/1")) === "x", "other tab missed gone/1 before the range delete");
  await self.batch((tx) =>
    tx.deleteRange({ start: enc.encode("gone/"), endExclusive: enc.encode("gone0") }),
  );
  for (const key of ["gone/1", "gone/2"]) {
    const got = await other.get(key);
    must(got === null, `other tab read ${key}=${got} after the range delete`);
  }
  must((await other.get("gone0")) === "kept", "range delete reached past its end");
  await other.ingest();
  const flushed = await other.get("gone/1");
  must(flushed === null, `other tab read gone/1=${flushed} after ingesting the range delete`);
  log("other tab saw gone/1 and gone/2 absent after the range delete");

  if (NOBC) {
    must(bcPosts > 0, "BroadcastChannel replacement was not used");
    log(`bc_posts=${bcPosts}`);
  }
  log(`scenario_ms=${Math.round(performance.now() - t0)}`);
  log("two-tab ok");
}

function parseCmd(value: unknown): PeerCmd | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as { id?: unknown; op?: unknown; key?: unknown; value?: unknown };
  if (typeof rec.id !== "number") return null;
  if (rec.op === "ingest") return { id: rec.id, op: "ingest" };
  if (rec.op === "get" && typeof rec.key === "string") {
    return { id: rec.id, op: "get", key: rec.key };
  }
  if (
    rec.op === "put" &&
    typeof rec.key === "string" &&
    typeof rec.value === "string"
  ) {
    return { id: rec.id, op: "put", key: rec.key, value: rec.value };
  }
  return null;
}

async function postResult(result: PeerResult): Promise<void> {
  const res = await fetch("/peer/result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`peer result ${res.status}`);
  }
}

async function servePeer(db: Handle): Promise<void> {
  for (;;) {
    const res = await fetch("/peer/next");
    if (!res.ok) throw new Error(`peer next ${res.status}`);
    const cmd = parseCmd(await res.json());
    if (!cmd) throw new Error("bad peer command");
    try {
      switch (cmd.op) {
        case "put":
          await db.put(enc.encode(cmd.key), enc.encode(cmd.value));
          await postResult({
            id: cmd.id,
            ok: true,
            value: null,
            generation: null,
            error: null,
          });
          break;
        case "get": {
          await db.sync();
          const got = text(await db.get(enc.encode(cmd.key)));
          await postResult({
            id: cmd.id,
            ok: true,
            value: got,
            generation: null,
            error: null,
          });
          break;
        }
        case "ingest": {
          const { generation } = await db.ingest();
          await postResult({
            id: cmd.id,
            ok: true,
            value: null,
            generation,
            error: null,
          });
          break;
        }
        default: {
          const _exhaustive: never = cmd;
          void _exhaustive;
        }
      }
    } catch (err) {
      await postResult({
        id: cmd.id,
        ok: false,
        value: null,
        generation: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function remoteOther(): Promise<OtherTab> {
  const ready = await fetch("/peer/ready");
  if (!ready.ok) throw new Error("tab B did not connect");
  return {
    async put(key, value) {
      await callPeer({ op: "put", key, value });
    },
    async get(key) {
      const result = await callPeer({ op: "get", key });
      return result.value;
    },
    async ingest() {
      const result = await callPeer({ op: "ingest" });
      must(typeof result.generation === "number", "ingest missing generation");
      return result.generation;
    },
  };
}

async function callPeer(cmd: {
  op: "put" | "get" | "ingest";
  key?: string;
  value?: string;
}): Promise<PeerResult> {
  const res = await fetch("/peer/call", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const body = (await res.json()) as PeerResult;
  if (!res.ok || !body.ok) {
    throw new Error(body.error ?? `peer call ${res.status}`);
  }
  return body;
}

async function run(): Promise<void> {
  statusEl.textContent = "running";
  out.textContent = "";
  const mod = await import("../dist/index.js");
  const testing = await import("../dist/testing.js");
  if (LOCAL) {
    const fs = await testing.openBrowserFs(DB_NAME);
    const host = new testing.EngineHost(() => fs);
    const ingest = testing.createLocalIngestClient(host);
    const shared = { fs, ingest };
    const self = await openHandle(mod, testing, "tab-a", shared);
    const otherDb = await openHandle(mod, testing, "tab-b", shared);
    const other: OtherTab = {
      async put(key, value) {
        await otherDb.put(enc.encode(key), enc.encode(value));
      },
      async get(key) {
        await otherDb.sync();
        return text(await otherDb.get(enc.encode(key)));
      },
      async ingest() {
        const { generation } = await otherDb.ingest();
        return generation;
      },
    };
    await scenario(self, other);
    await self.close();
    await otherDb.close();
    return;
  }

  if (ROLE === "b") {
    const db = await openHandle(mod, testing, "tab-b");
    log("mode=" + modeLabel());
    log("tab B ready");
    const ready = await fetch("/peer/ready", { method: "POST" });
    if (!ready.ok) throw new Error("ready rejected");
    await servePeer(db);
    return;
  }

  const db = await openHandle(mod, testing, "tab-a");
  await scenario(db, await remoteOther());
  await db.close();
}

async function finish(): Promise<void> {
  let failed: string | undefined;
  try {
    await run();
  } catch (err) {
    const e = err as Error;
    failed = String(e?.stack || err);
    log(failed);
  }
  statusEl.textContent = "idle";
  runBtn.disabled = false;
  if (ROLE === "b" && !failed) return;
  if (failed) await report({ error: failed, log: out.textContent });
  else await report({ log: out.textContent });
}

runBtn.addEventListener("click", () => {
  runBtn.disabled = true;
  void finish();
});

if (AUTO) {
  runBtn.disabled = true;
  void finish();
}
