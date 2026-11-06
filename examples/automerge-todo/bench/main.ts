/**
 * Headless Chrome load bench: kv automerge storage vs IndexedDB storage.
 *
 *   pnpm --filter @opfs-lsm/kv build
 *   pnpm --filter @opfs-lsm/example-automerge bench:load
 *
 * Query: docs, runs, concurrency. The driver sets those and reads
 * window.__BENCH when the page has finished every reload.
 *
 * Each document is one note (title, a short body, two tags) created and
 * edited once, then saved by repo.flush. saveDebounceRate is an hour, so
 * flush is the write. kv stays on the SharedWorker + OPFS path. A huge
 * maxWalBytes keeps the WAL shape from ingesting; the SST shape calls
 * db.ingest() (which also waits for compaction) before the load reloads.
 */
import { IndexedDBStorageAdapter, Repo, type Repo as RepoType } from "@automerge/react"
import { openDb, type Db } from "@opfs-lsm/kv"
import { kvStorage } from "../src/storage.ts"

type Note = {
  title: string
  body: string
  created: number
  tags: string[]
}

type Shape = "kv-wal" | "kv-sst" | "idb"

type Stats = {
  saveN: number
  saveMs: number
  saveBytes: number
  loadN: number
  loadMs: number
  rangeN: number
  rangeMs: number
  rangeChunks: number
  rangeBytes: number
  decodeN: number
  decodeMs: number
}

type LoadPass = Stats & {
  pass: "cold" | "warm"
  openMs: number
  firstMs: number
  allMs: number
  checked: number
}

type WriteResult = {
  shape: Shape
  attempt: number
  createMs: number
  flushMs: number
  ingestMs: number
  populateMs: number
  docs: number
  generation: number
  saveN: number
  saveBytes: number
  opfsBytes: number
  walRecords: number
  idbRecords: number
  originUsage: number
  urls: string[]
}

type BenchState = {
  docs: number
  runs: number
  concurrency: number
  writes: WriteResult[]
  loads: { shape: Shape; order: number; passes: LoadPass[] }[]
  nextRun: number
}

const SHAPES: Shape[] = ["kv-wal", "kv-sst", "idb"]
const SAVE_DEBOUNCE_MS = 60 * 60 * 1000
const NO_AUTO_INGEST = Number.MAX_SAFE_INTEGER
const params = new URLSearchParams(location.search)
const DOCS = Number(params.get("docs") ?? 5000)
const RUNS = Number(params.get("runs") ?? 3)
const CONCURRENCY = Number(params.get("concurrency") ?? 20)
const STATE_KEY = "am-load-bench"

declare global {
  interface Window {
    __BENCH?: BenchState | { error: string }
    __BENCH_STATUS?: string
  }
}

function status(text: string): void {
  window.__BENCH_STATUS = text
  const el = document.getElementById("status")
  if (el) el.textContent = text
}

function emptyStats(): Stats {
  return {
    saveN: 0,
    saveMs: 0,
    saveBytes: 0,
    loadN: 0,
    loadMs: 0,
    rangeN: 0,
    rangeMs: 0,
    rangeChunks: 0,
    rangeBytes: 0,
    decodeN: 0,
    decodeMs: 0,
  }
}

type Storage = {
  load(key: string[]): Promise<Uint8Array | undefined>
  save(key: string[], data: Uint8Array): Promise<void>
  remove(key: string[]): Promise<void>
  loadRange(keyPrefix: string[]): Promise<{ key: string[]; data: Uint8Array }[]>
  removeRange(keyPrefix: string[]): Promise<void>
  close?(): void | Promise<void>
}

function timed(inner: Storage, stats: Stats): Storage {
  return {
    async load(key) {
      const t = performance.now()
      try {
        return await inner.load(key)
      } finally {
        stats.loadN += 1
        stats.loadMs += performance.now() - t
      }
    },
    async save(key, data) {
      const t = performance.now()
      try {
        await inner.save(key, data)
      } finally {
        stats.saveN += 1
        stats.saveMs += performance.now() - t
        stats.saveBytes += data.byteLength
      }
    },
    remove: (key) => inner.remove(key),
    async loadRange(prefix) {
      const t = performance.now()
      const chunks = await inner.loadRange(prefix)
      stats.rangeN += 1
      stats.rangeMs += performance.now() - t
      stats.rangeChunks += chunks.length
      for (const chunk of chunks) stats.rangeBytes += chunk.data.byteLength
      return chunks
    },
    removeRange: (prefix) => inner.removeRange(prefix),
    close: () => inner.close?.(),
  }
}

function dbName(shape: Shape): string {
  if (shape === "kv-wal") return "ambench-kv-wal"
  if (shape === "kv-sst") return "ambench-kv-sst"
  return "ambench-idb"
}

async function openKv(shape: Shape): Promise<Db> {
  return openDb({
    name: dbName(shape),
    ingestPolicy: { maxWalBytes: NO_AUTO_INGEST },
  } as Parameters<typeof openDb>[0])
}

function repoFor(shape: Shape, storage: Storage): RepoType {
  return new Repo({
    storage,
    network: [],
    peerId: `bench-${shape}` as never,
    saveDebounceRate: SAVE_DEBOUNCE_MS,
    flushConcurrency: CONCURRENCY,
    isEphemeral: false,
  })
}

async function openRepo(
  shape: Shape,
  stats: Stats,
): Promise<{ repo: RepoType; db?: Db }> {
  if (shape === "idb") {
    const inner = new IndexedDBStorageAdapter(dbName(shape), "documents")
    // The constructor starts the open and returns. Wait for it here so openMs
    // includes IndexedDB open, the way kv's openMs includes WAL replay.
    await inner.load(["__bench_open__"])
    return { repo: repoFor(shape, timed(inner, stats)) }
  }
  const db = await openKv(shape)
  return { repo: repoFor(shape, timed(kvStorage(db) as Storage, stats)), db }
}

async function loadAll(
  repo: RepoType,
  urls: readonly string[],
  t0: number,
): Promise<{ firstMs: number; allMs: number; checked: number }> {
  let cursor = 0
  let firstMs = 0
  let checked = 0
  let missing = 0
  const worker = async () => {
    for (;;) {
      const i = cursor++
      if (i >= urls.length) return
      const handle = await repo.find(urls[i]!)
      const doc = handle.doc() as Note | undefined
      if (!doc?.title) missing += 1
      else checked += 1
      if (firstMs === 0) firstMs = performance.now() - t0
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, () => worker()))
  if (missing > 0) throw new Error(`${missing} documents loaded without a title`)
  return { firstMs, allMs: performance.now() - t0, checked }
}

async function measurePass(shape: Shape, urls: readonly string[], pass: "cold" | "warm"): Promise<LoadPass> {
  const stats = emptyStats()
  const t0 = performance.now()
  const { repo } = await openRepo(shape, stats)
  const openMs = performance.now() - t0
  repo.on("doc-metrics", (event) => {
    const metric = event as { type?: string; durationMillis?: number }
    if (metric.type === "doc-loaded" && typeof metric.durationMillis === "number") {
      stats.decodeN += 1
      stats.decodeMs += metric.durationMillis
    }
  })
  const loaded = await loadAll(repo, urls, t0)
  await repo.shutdown()
  return { pass, openMs, ...loaded, ...stats }
}

async function dirBytes(dir: FileSystemDirectoryHandle): Promise<number> {
  let total = 0
  const entries = (
    dir as FileSystemDirectoryHandle & {
      entries(): AsyncIterableIterator<[string, FileSystemHandle]>
    }
  ).entries()
  for await (const [, handle] of entries) {
    if (handle.kind === "file") {
      total += (await (handle as FileSystemFileHandle).getFile()).size
    } else {
      total += await dirBytes(handle as FileSystemDirectoryHandle)
    }
  }
  return total
}

async function opfsBytes(shape: Shape): Promise<number> {
  if (shape === "idb") return 0
  try {
    const root = await navigator.storage.getDirectory()
    const lsm = await root.getDirectoryHandle("opfs-lsm")
    const db = await lsm.getDirectoryHandle(dbName(shape))
    return await dirBytes(db)
  } catch {
    return 0
  }
}

function idbCount(database: string, store: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(database)
    req.onerror = () => reject(req.error ?? new Error(`open ${database}`))
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(store)) {
        db.close()
        resolve(0)
        return
      }
      const tx = db.transaction(store, "readonly")
      const count = tx.objectStore(store).count()
      count.onsuccess = () => {
        resolve(count.result)
        db.close()
      }
      count.onerror = () => reject(count.error ?? new Error(`count ${store}`))
    }
  })
}

async function originUsage(): Promise<number> {
  const estimate = await navigator.storage.estimate()
  return estimate.usage ?? 0
}

async function populate(shape: Shape): Promise<WriteResult> {
  status(`write ${shape}: creating ${DOCS} docs`)
  const stats = emptyStats()
  const started = performance.now()
  const { repo, db } = await openRepo(shape, stats)
  const urls: string[] = []
  const createStarted = performance.now()
  for (let i = 0; i < DOCS; i++) {
    const handle = repo.create<Note>({
      title: `Note ${i}`,
      body: `Buy groceries and call the office about invoice ${i}. The meeting is Thursday at 10.`,
      created: 1_700_000_000_000 + i * 1000,
      tags: [i % 2 === 0 ? "work" : "home", "inbox"],
    })
    handle.change((doc) => {
      doc.body += " — done"
      doc.tags.push("edited")
    })
    urls.push(handle.url)
    if (i > 0 && i % 250 === 0) {
      status(`write ${shape}: created ${i}/${DOCS}`)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  const createMs = performance.now() - createStarted
  status(`write ${shape}: flush`)
  const flushStarted = performance.now()
  await repo.flush()
  const flushMs = performance.now() - flushStarted
  let ingestMs = 0
  let generation = 0
  if (shape === "kv-sst" && db) {
    status(`write ${shape}: ingest`)
    const ingestStarted = performance.now()
    generation = (await db.ingest()).generation
    ingestMs = performance.now() - ingestStarted
  }
  const [opfs, walRecords, idbRecords, usage] = await Promise.all([
    opfsBytes(shape),
    shape === "idb" ? Promise.resolve(0) : idbCount(`opfs-lsm-wal/${dbName(shape)}`, "wal"),
    shape === "idb" ? idbCount(dbName(shape), "documents") : Promise.resolve(0),
    originUsage(),
  ])
  await repo.shutdown()
  return {
    shape,
    attempt: 0,
    createMs,
    flushMs,
    ingestMs,
    populateMs: performance.now() - started,
    docs: urls.length,
    generation,
    saveN: stats.saveN,
    saveBytes: stats.saveBytes,
    opfsBytes: opfs,
    walRecords,
    idbRecords,
    originUsage: usage,
    urls,
  }
}

function rotate(run: number): Shape[] {
  const shift = run % SHAPES.length
  return [...SHAPES.slice(shift), ...SHAPES.slice(0, shift)]
}

function loadState(): BenchState | undefined {
  const raw = sessionStorage.getItem(STATE_KEY)
  if (!raw) return undefined
  const state = JSON.parse(raw) as BenchState
  if (state.docs !== DOCS || state.runs !== RUNS || state.concurrency !== CONCURRENCY) return undefined
  return state
}

function saveState(state: BenchState): void {
  sessionStorage.setItem(STATE_KEY, JSON.stringify(state))
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error(`delete ${name}`))
  })
}

async function wipe(shape: Shape): Promise<void> {
  await deleteDatabase(shape === "idb" ? dbName(shape) : `opfs-lsm-wal/${dbName(shape)}`)
  if (shape === "idb") return
  try {
    const root = await navigator.storage.getDirectory()
    const lsm = await root.getDirectoryHandle("opfs-lsm")
    await lsm.removeEntry(dbName(shape), { recursive: true })
  } catch {
    // nothing written there yet
  }
}

async function main(): Promise<void> {
  if (!params.has("auto")) {
    status("open with ?auto=1")
    return
  }
  let state = loadState()
  if (!state) {
    const writes: WriteResult[] = []
    for (let attempt = 0; attempt < RUNS; attempt++) {
      for (const shape of SHAPES) {
        if (attempt > 0) await wipe(shape)
        status(`write ${attempt + 1}/${RUNS} ${shape}`)
        const result = await populate(shape)
        result.attempt = attempt
        writes.push(result)
      }
    }
    for (const write of writes) {
      if (write.attempt < RUNS - 1) write.urls = []
    }
    state = { docs: DOCS, runs: RUNS, concurrency: CONCURRENCY, writes, loads: [], nextRun: 0 }
    saveState(state)
    status(`wrote ${DOCS} docs x ${SHAPES.length}, reloading for cold load`)
    location.reload()
    return
  }
  if (state.nextRun < state.runs) {
    const order = rotate(state.nextRun)
    status(`cold run ${state.nextRun + 1}/${state.runs}: ${order.join(" then ")}`)
    for (let i = 0; i < order.length; i++) {
      const shape = order[i]!
      const urls = state.writes.findLast((write) => write.shape === shape)!.urls
      status(`run ${state.nextRun + 1} ${shape}: cold load`)
      const cold = await measurePass(shape, urls, "cold")
      status(`run ${state.nextRun + 1} ${shape}: warm load`)
      const warm = await measurePass(shape, urls, "warm")
      state.loads.push({ shape, order: i, passes: [cold, warm] })
    }
    state.nextRun += 1
    saveState(state)
    if (state.nextRun < state.runs) {
      status(`reload for cold run ${state.nextRun + 1}/${state.runs}`)
      location.reload()
      return
    }
  }
  const published: BenchState = {
    docs: state.docs,
    runs: state.runs,
    concurrency: state.concurrency,
    writes: state.writes.map(({ urls: _urls, ...write }) => ({ ...write, urls: [] })),
    loads: state.loads,
    nextRun: state.nextRun,
  }
  window.__BENCH = published
  status("done")
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err)
  window.__BENCH = { error: message }
  status(message)
})
