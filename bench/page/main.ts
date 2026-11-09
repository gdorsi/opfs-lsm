/**
 * The bench page: a phase executor. The driver calls
 * `__bench.runPhase(req)` over CDP `Runtime.evaluate` and gets the reply as
 * the evaluate result. No HTTP POSTs (a crashed headless network service
 * drops them), no polling.
 *
 * Workloads and contenders are found with import.meta.glob, so the
 * directories are the only list.
 */
import type { FamilyStores } from "../core/families.ts";
import { FAMILIES } from "../core/families.ts";
import { Histogram } from "../core/histogram.ts";
import type {
  Catalog,
  Contender,
  Family,
  Footprint,
  PhaseContext,
  PhaseReply,
  PhaseRequest,
  Workload,
} from "../core/types.ts";
import { CorrectnessError, createModel, rng, seedOf } from "./model.ts";

type AnyWorkload = Workload<Family>;
type AnyContender = Contender<Family>;

const workloadModules = import.meta.glob<{ default: AnyWorkload }>("../workloads/*/*.ts");
const contenderModules = import.meta.glob<{ default: AnyContender }>("../contenders/*/*.ts");

/** The only place the path ↔ id rule lives. */
function idOf(globKey: string): { family: Family; id: string } {
  const m = /\/(?:workloads|contenders)\/([^/]+)\/([^/]+)\.ts$/.exec(globKey);
  if (!m) throw new Error(`bad module path ${globKey}`);
  const family = m[1] as Family;
  if (!FAMILIES.includes(family)) throw new Error(`${globKey}: unknown family "${m[1]}"`);
  return { family, id: `${m[1]}/${m[2]}` };
}

async function load<T extends { family: Family }>(
  modules: Record<string, () => Promise<{ default: T }>>,
  id: string,
): Promise<T> {
  for (const [key, importer] of Object.entries(modules)) {
    if (idOf(key).id !== id) continue;
    const value = (await importer()).default;
    if (value.family !== idOf(key).family) {
      throw new Error(`${key} declares family "${value.family}" but lives under "${idOf(key).family}"`);
    }
    return value;
  }
  throw new Error(`no module with id ${id}`);
}

async function catalog(): Promise<Catalog> {
  const contenders = Object.keys(contenderModules).map(idOf);
  const out = [];
  for (const key of Object.keys(workloadModules).sort()) {
    const { family, id } = idOf(key);
    const w = await load(workloadModules, id);
    out.push({
      workload: id,
      family,
      title: w.title,
      phases: w.phases.map((p) => ({ name: p.name, page: p.page })),
      contenders: contenders
        .filter((c) => c.family === family && (!w.contenders || w.contenders.some((n) => c.id === `${family}/${n}`)))
        .map((c) => c.id)
        .sort(),
    });
  }
  return out;
}

/** The open store survives "same" phases; a "fresh" phase starts on a new page with only `carry`. */
let open: { key: string; store: FamilyStores[Family] } | undefined;
let touched = false;

async function runPhase(req: PhaseRequest): Promise<PhaseReply> {
  if (!crossOriginIsolated) throw new Error("page is not cross-origin isolated: timers are coarse");
  if (!touched) {
    await touchStorage();
    touched = true;
  }
  const workload = await load(workloadModules, req.workload);
  const contender = await load(contenderModules, req.contender);
  const phase = workload.phases[req.phase];
  if (!phase) throw new Error(`${req.workload} has no phase ${req.phase}`);
  const params = workload.params(req.size);

  const carried = req.carry === undefined ? undefined : (JSON.parse(req.carry) as { model: string; extra: Record<string, unknown> });
  const model = createModel(params, carried?.model);
  const latency = new Map<string, Histogram>();
  let ops = 0;
  let userBytes = 0;
  const storeKey = `${req.contender}:${req.dbName}`;

  const time = async <T>(op: string, bytes: number, fn: () => Promise<T>, count = 1): Promise<T> => {
    const t0 = performance.now();
    const value = await fn();
    const us = (performance.now() - t0) * 1000;
    let h = latency.get(op);
    if (!h) latency.set(op, (h = new Histogram()));
    h.record(us);
    if (op !== "open") ops += count;
    userBytes += bytes;
    return value;
  };

  const store = async () => {
    if (open?.key !== storeKey) {
      if (open) await open.store.close();
      const s = await time("open", 0, () => contender.open(req.dbName, params));
      open = { key: storeKey, store: s };
    }
    return open.store;
  };

  const ctx: PhaseContext<Family> = {
    params,
    size: req.size,
    store: store as PhaseContext<Family>["store"],
    model,
    rng: rng(seedOf(req.workload, req.phase, req.rep, params.seed)),
    time,
    bytes(n) {
      userBytes += n;
    },
    check(ok, what) {
      if (!ok) throw new CorrectnessError(what);
    },
    carry: carried?.extra ?? {},
    progress,
  };

  const t0 = performance.now();
  await phase.run(ctx);
  const wallMs = performance.now() - t0;

  let footprint: Footprint | undefined;
  if (phase.footprint) {
    const s = await store();
    const estimate = await navigator.storage.estimate();
    footprint = {
      opfsBytes: await walkOpfs(),
      idbEstimateBytes: (estimate as { usageDetails?: { indexedDB?: number } }).usageDetails?.indexedDB ?? 0,
      liveLogicalBytes: typeof ctx.carry.liveLogicalBytes === "number" ? ctx.carry.liveLogicalBytes : model.liveLogicalBytes(),
      ...(contender.engine ? { kv: await s.stats() } : {}),
    };
  }

  return {
    result: {
      name: phase.name,
      page: phase.page,
      timed: phase.timed,
      wallMs,
      ops,
      userBytes,
      latency: Object.fromEntries([...latency].map(([op, h]) => [op, h.snapshot()])),
      ...(footprint ? { footprint } : {}),
    },
    carry: JSON.stringify({ model: model.carry(), extra: ctx.carry }),
    durability: contender.durability,
    fastPath: contender.fastPath,
    params,
  };
}

/** Close the open store, so the page can be closed with nothing in flight. */
async function closeStore(): Promise<void> {
  if (open) await open.store.close();
  open = undefined;
}

/** First storage touch on a fresh profile is slow; pay it outside any timing. */
async function touchStorage(): Promise<void> {
  await navigator.storage.getDirectory();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open("bench-touch");
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase("bench-touch");
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

/** Sum of every file size under the OPFS root. Includes orphans on purpose. */
async function walkOpfs(dir?: FileSystemDirectoryHandle): Promise<number> {
  const root = dir ?? (await navigator.storage.getDirectory());
  let total = 0;
  for await (const handle of (root as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
    if (handle.kind === "file") total += (await (handle as FileSystemFileHandle).getFile()).size;
    else total += await walkOpfs(handle as FileSystemDirectoryHandle);
  }
  return total;
}

function progress(line: string): void {
  (globalThis as { __benchProgress?: (s: string) => void }).__benchProgress?.(line);
}

(globalThis as unknown as { __bench: unknown }).__bench = { catalog, runPhase, closeStore };
