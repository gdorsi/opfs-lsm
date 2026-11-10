/**
 * Two tabs on one database through the SharedWorker. Tab A reads its own
 * write at ack, sees tab B's write after sync(), keeps a view on one state
 * while B writes and ingests, and measures how long B's write takes to show
 * up in A with no sync (the SharedWorker's latency ingest and the
 * BroadcastChannel note).
 *
 *   ?auto=1&role=a     leader tab
 *   ?auto=1&role=b     peer tab
 *   ?local=1           one page, two handles, one Host on the page
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

/** Channels the page opened while ?nobc=1 silenced them: the SharedWorker posts, pages listen. */
let bcOpened = 0;

if (NOBC) {
  class SilentChannel {
    onmessage: unknown = null;
    constructor(_name: string) {
      bcOpened += 1;
    }
    postMessage(_data: unknown): void {}
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

const enc = new TextEncoder();
const dec = new TextDecoder();

type Handle = {
  put(key: Uint8Array, value: Uint8Array): Promise<void>;
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  ingest(): Promise<{ generation: number }>;
  range(): AsyncIterable<{ key: Uint8Array; value: Uint8Array }>;
  view<T>(
    body: (snap: {
      readonly generation: number;
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
  const base = LOCAL ? "local Host" : "SharedWorker";
  return NOBC ? `${base} nobc` : base;
}

/** How long tab A polls for a write of tab B before giving up. */
const VISIBLE_WITHIN_MS = 10_000;

async function scenario(self: Handle, other: OtherTab): Promise<void> {
  const t0 = performance.now();
  log(`mode=${modeLabel()}`);
  log(
    `OPFS=${!!navigator.storage?.getDirectory}  SharedWorker=${typeof SharedWorker !== "undefined"}`,
  );

  await self.put(enc.encode("seed"), enc.encode("s"));
  const own = text(await self.get(enc.encode("seed")));
  must(own === "s", `own write read back ${own} at ack`);
  const seeded = await self.ingest();
  const seed = text(await self.get(enc.encode("seed")));
  must(seed === "s", `warm get seed was ${seed}`);
  must(seeded.generation >= 1, "seed ingest did not publish a generation");
  log(`own write at ack; warm seed generation=${seeded.generation}`);

  await other.put("k", "v");
  await self.sync();
  const synced = text(await self.get(enc.encode("k")));
  must(synced === "v", `get after sync was ${synced}`);
  log("sync k=v");

  const pin = await self.view(async (snap) => {
    const before = text(await snap.get(enc.encode("k")));
    const generation = snap.generation;
    await other.put("k", "v2");
    const ingested = await other.ingest();
    const after = text(await snap.get(enc.encode("k")));
    return { before, after, generation, ingested };
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

  await self.sync();
  const fresh = text(await self.get(enc.encode("k")));
  must(fresh === "v2", `fresh get after the view was ${fresh}`);
  log("fresh k=v2");

  if (NOBC) {
    log("visible_ms skipped: no BroadcastChannel");
  } else {
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      const key = enc.encode(`lag/${i}`);
      await other.put(`lag/${i}`, "x");
      const acked = performance.now();
      while (text(await self.get(key)) !== "x") {
        must(performance.now() - acked < VISIBLE_WITHIN_MS, `lag/${i} not visible after ${VISIBLE_WITHIN_MS} ms`);
        await new Promise((r) => setTimeout(r, 5));
      }
      delays.push(Math.round(performance.now() - acked));
    }
    log(`visible_ms=${delays.join(",")}`);
  }

  let ranged = false;
  for await (const entry of self.range()) {
    if (text(entry.key) === "k" && text(entry.value) === "v2") ranged = true;
  }
  must(ranged, "range missed k=v2");
  log("range has k");

  await self.put(enc.encode("after"), enc.encode("yes"));
  const seen = await other.get("after");
  must(seen === "yes", `other tab get after sync was ${seen}`);
  log("other tab saw after=yes");

  if (NOBC) {
    must(bcOpened > 0, "BroadcastChannel replacement was not used");
    log(`bc_opened=${bcOpened}`);
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
    const fs = await mod.openBrowserFs(DB_NAME);
    const host = new testing.Host(() => fs);
    const self = await testing.openHarnessDb({ name: DB_NAME, fs, host });
    const otherDb = await testing.openHarnessDb({ name: DB_NAME, fs, host });
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
    const db = await mod.openDb({ name: DB_NAME });
    log("mode=" + modeLabel());
    log("tab B ready");
    const ready = await fetch("/peer/ready", { method: "POST" });
    if (!ready.ok) throw new Error("ready rejected");
    await servePeer(db);
    return;
  }

  const db = await mod.openDb({ name: DB_NAME });
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
