type BenchRow = { label: string; ms: number; ops: number };

type User = { id: string; email: string; name: string };

const out = document.getElementById("out")!;
const runBtn = document.getElementById("run") as HTMLButtonElement;
const params = new URLSearchParams(location.search);
const N = Number(params.get("n") ?? 200);
const AUTO = params.has("auto");
const LOCAL = params.has("local");
const PROFILE = params.has("profile");

function log(line: string): void {
  out.textContent += line + "\n";
}

async function report(payload: unknown): Promise<void> {
  if (!AUTO) return;
  try {
    await fetch("/bench-results", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("report failed", err);
  }
}

async function time(label: string, fn: () => Promise<void>): Promise<BenchRow> {
  const t0 = performance.now();
  await fn();
  const ms = performance.now() - t0;
  const ops = Number((N / (ms / 1000)).toFixed(0));
  log(`${label.padEnd(32)} ${ms.toFixed(1)} ms  (${ops} ops/s)`);
  return { label, ms, ops };
}

async function resetIdb(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

async function clearOpfs(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("opfs-lsm", { recursive: true });
  } catch {
    /* missing is fine */
  }
}

function user(i: number): User {
  return {
    id: `u${i}`,
    email: `u${i}@example.com`,
    name: `User ${i}`,
  };
}

async function benchCollections(): Promise<BenchRow[]> {
  const { openHarnessCollectionDb } = await import(
    "@opfs-lsm/collections/testing"
  );
  const {
    openBrowserFs,
    EngineHost,
    createLocalIngestClient,
  } = await import("@opfs-lsm/kv");

  await resetIdb("opfs-lsm-wal/bench-collections");
  await clearOpfs();

  const schema = {
    tables: [
      {
        name: "users",
        indexes: [{ name: "email", path: "email" }],
      },
    ],
  };

  let openOpts = {
    name: "bench-collections",
    writerId: "bench",
    schema,
    ingestPolicy: { maxWalBytes: 1 << 30 },
  };

  if (LOCAL) {
    const fs = await openBrowserFs("bench-collections");
    const host = new EngineHost(() => fs);
    openOpts = {
      ...openOpts,
      fs,
      ingest: createLocalIngestClient(host),
    };
    log("mode=local EngineHost + BrowserFs (OPFS)");
  } else {
    log("mode=SharedWorker + BrowserFs (OPFS)");
  }

  const db = await openHarnessCollectionDb(openOpts);
  const users = db.table<User>("users");
  const rows: BenchRow[] = [];

  rows.push(
    await time("collections solitary put", async () => {
      for (let i = 0; i < N; i++) {
        await users.put(user(i));
      }
    }),
  );

  rows.push(
    await time("collections get by id", async () => {
      for (let i = 0; i < N; i++) {
        const got = await users.get(`u${i}`);
        if (got?.email !== `u${i}@example.com`) {
          throw new Error(`collections get missing u${i}`);
        }
      }
    }),
  );

  rows.push(
    await time("collections where email", async () => {
      for (let i = 0; i < N; i++) {
        const found = await users.where("email", `u${i}@example.com`);
        if (found.length !== 1 || found[0]?.id !== `u${i}`) {
          throw new Error(`collections where missing u${i}`);
        }
      }
    }),
  );

  if (PROFILE) {
    const { prefixBound } = await import("@opfs-lsm/kv");
    const {
      indexPrefix,
      extractIndexRowId,
      primaryKey,
    } = await import("@opfs-lsm/collections");
    let rangeMs = 0;
    let getMs = 0;
    let viewOpenMs = 0;
    let idCount = 0;
    for (let i = 0; i < N; i++) {
      const email = `u${i}@example.com`;
      const eq = prefixBound(indexPrefix("users", "email", [email]));
      const tView0 = performance.now();
      await db.kv.view(async (snap) => {
        viewOpenMs += performance.now() - tView0;
        const tR0 = performance.now();
        const ids: string[] = [];
        for await (const entry of snap.range({
          start: eq.start,
          ...(eq.endExclusive !== undefined
            ? { endExclusive: eq.endExclusive }
            : {}),
        })) {
          const id = extractIndexRowId(entry.key, 1);
          if (id !== undefined) ids.push(id);
        }
        rangeMs += performance.now() - tR0;
        idCount += ids.length;
        const tG0 = performance.now();
        for (const id of ids) {
          await snap.get(primaryKey("users", id));
        }
        getMs += performance.now() - tG0;
      });
    }
    log(
      `profile where×${N}: viewOpen=${viewOpenMs.toFixed(1)}ms range=${rangeMs.toFixed(1)}ms get=${getMs.toFixed(1)}ms ids=${idCount}`,
    );
  }

  rows.push(
    await time("collections ingest → OPFS", async () => {
      await db.ingest();
    }),
  );

  rows.push(
    await time("collections get (post-ingest)", async () => {
      for (let i = 0; i < N; i++) {
        const got = await users.get(`u${i}`);
        if (got?.email !== `u${i}@example.com`) {
          throw new Error(`collections post-ingest get missing u${i}`);
        }
      }
    }),
  );

  rows.push(
    await time("collections where (post-ingest)", async () => {
      for (let i = 0; i < N; i++) {
        const found = await users.where("email", `u${i}@example.com`);
        if (found.length !== 1 || found[0]?.id !== `u${i}`) {
          throw new Error(`collections post-ingest where missing u${i}`);
        }
      }
    }),
  );

  if (PROFILE) {
    const { prefixBound } = await import("@opfs-lsm/kv");
    const {
      indexPrefix,
      extractIndexRowId,
      primaryKey,
    } = await import("@opfs-lsm/collections");
    let rangeMs = 0;
    let getMs = 0;
    let viewOpenMs = 0;
    for (let i = 0; i < N; i++) {
      const eq = prefixBound(
        indexPrefix("users", "email", [`u${i}@example.com`]),
      );
      const tView0 = performance.now();
      await db.kv.view(async (snap) => {
        viewOpenMs += performance.now() - tView0;
        const tR0 = performance.now();
        const ids: string[] = [];
        for await (const entry of snap.range({
          start: eq.start,
          ...(eq.endExclusive !== undefined
            ? { endExclusive: eq.endExclusive }
            : {}),
        })) {
          const id = extractIndexRowId(entry.key, 1);
          if (id !== undefined) ids.push(id);
        }
        rangeMs += performance.now() - tR0;
        const tG0 = performance.now();
        for (const id of ids) {
          await snap.get(primaryKey("users", id));
        }
        getMs += performance.now() - tG0;
      });
    }
    log(
      `profile where post×${N}: viewOpen=${viewOpenMs.toFixed(1)}ms range=${rangeMs.toFixed(1)}ms get=${getMs.toFixed(1)}ms`,
    );
  }

  await db.close();
  return rows;
}

async function benchDexie(): Promise<BenchRow[]> {
  const { default: Dexie } = await import("dexie");
  await resetIdb("bench-dexie-collections");
  const db = new Dexie("bench-dexie-collections");
  db.version(1).stores({ users: "id, email" });
  await db.open();
  const table = db.table("users");
  const rows: BenchRow[] = [];

  rows.push(
    await time("dexie solitary put", async () => {
      for (let i = 0; i < N; i++) {
        await table.put(user(i));
      }
    }),
  );

  rows.push(
    await time("dexie bulkPut", async () => {
      await table.bulkPut(Array.from({ length: N }, (_, i) => user(i + N)));
    }),
  );

  rows.push(
    await time("dexie get by id", async () => {
      for (let i = 0; i < N; i++) {
        const got = await table.get(`u${i}`);
        if (got?.email !== `u${i}@example.com`) {
          throw new Error(`dexie get missing u${i}`);
        }
      }
    }),
  );

  rows.push(
    await time("dexie where email", async () => {
      for (let i = 0; i < N; i++) {
        const found = await table.where("email").equals(`u${i}@example.com`).toArray();
        if (found.length !== 1 || found[0]?.id !== `u${i}`) {
          throw new Error(`dexie where missing u${i}`);
        }
      }
    }),
  );

  await db.close();
  return rows;
}

async function run(): Promise<void> {
  out.textContent = "";
  log(`N=${N}  origin=${location.origin}`);
  log(
    `OPFS=${!!navigator.storage?.getDirectory}  SharedWorker=${typeof SharedWorker !== "undefined"}`,
  );
  log("");
  let results: BenchRow[] = [];
  try {
    results = results.concat(await benchCollections());
  } catch (err) {
    const e = err as Error;
    log(`collections FAILED: ${e?.stack || err}`);
    await report({ error: String(e?.stack || err), log: out.textContent });
    throw err;
  }
  log("");
  try {
    results = results.concat(await benchDexie());
  } catch (err) {
    const e = err as Error;
    log(`dexie FAILED: ${e?.stack || err}`);
  }
  await report({ n: N, results, log: out.textContent });
}

runBtn.addEventListener("click", () => {
  runBtn.disabled = true;
  void run().finally(() => {
    runBtn.disabled = false;
  });
});

if (AUTO) {
  runBtn.disabled = true;
  void run().catch((err) => {
    console.error(err);
  });
}
