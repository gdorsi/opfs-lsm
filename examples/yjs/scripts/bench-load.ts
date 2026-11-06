/**
 * Drive bench/index.html in headless Chrome (OPFS + SharedWorker): load DOCS
 * Yjs documents out of a set of DOCS * 10, on kv and on y-indexeddb.
 *
 *   pnpm --filter @opfs-lsm/example-yjs bench:load
 *   DOCS=500 RUNS=5 pnpm --filter @opfs-lsm/example-yjs bench:load
 *
 * Env: DOCS (default 5000), RUNS (3), CONCURRENCY (20), EDITS (updates per
 * document, 5), BENCH_TIMEOUT_MS, BENCH_OUT (write the raw JSON there).
 */
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const docs = Number(process.env.DOCS ?? 5000)
const runs = Number(process.env.RUNS ?? 3)
const concurrency = Number(process.env.CONCURRENCY ?? 20)
const edits = Number(process.env.EDITS ?? 5)
const timeoutMs = Number(process.env.BENCH_TIMEOUT_MS ?? 30 * 60 * 1000)
const exampleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

type LoadPass = {
  pass: "cold" | "warm"
  openMs: number
  firstMs: number
  allMs: number
  docMsSum: number
  docMsMax: number
  checked: number
}

type WriteResult = {
  shape: string
  writeMs: number
  ingestMs: number
  docs: number
  updates: number
  updateBytes: number
  opfsBytes: number
  walRecords: number
  originUsage: number
}

type BenchState = {
  docs: number
  total: number
  runs: number
  concurrency: number
  edits: number
  writes: WriteResult[]
  loads: { shape: string; run: number; order: number; passes: LoadPass[] }[]
  nextRun: number
}
function chromePath(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  if (fs.existsSync(mac)) return mac
  return "google-chrome"
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("expected TCP listen address"))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

function killProcess(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    try {
      child.kill("SIGKILL")
    } catch {
      /* already gone */
    }
  }
}

type Target = { id?: string; type?: string; url?: string; webSocketDebuggerUrl?: string }

async function listTargets(debugPort: number): Promise<Target[]> {
  const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
  if (!res.ok) throw new Error(`json/list ${res.status}`)
  return (await res.json()) as Target[]
}

function devtoolsCall(wsUrl: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`${method} timeout`))
    }, 20_000)
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method, params }))
    })
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number
        error?: { message?: string }
        result?: {
          exceptionDetails?: { text?: string; exception?: { description?: string } }
          result?: { value?: unknown }
        }
      }
      if (msg.id !== 1) return
      clearTimeout(timer)
      ws.close()
      if (msg.error) {
        reject(new Error(msg.error.message ?? `${method} failed`))
        return
      }
      const details = msg.result?.exceptionDetails
      if (details) {
        reject(new Error(details.exception?.description ?? details.text ?? `${method} threw`))
        return
      }
      resolve(msg.result?.result?.value)
    })
    ws.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("devtools socket error"))
    })
  })
}

async function pageSocket(debugPort: number, pageUrl: string): Promise<string> {
  const deadline = Date.now() + 30_000
  let last = "page missing"
  while (Date.now() < deadline) {
    try {
      const page = (await listTargets(debugPort)).find(
        (target) => target.type === "page" && (target.url ?? "").startsWith(pageUrl) && target.webSocketDebuggerUrl,
      )
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
      last = "page not listed"
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
    }
    await sleep(100)
  }
  throw new Error(last)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function ms(n: number): string {
  return n.toFixed(1).padStart(10)
}

function report(state: BenchState): void {
  const shapes = ["kv-wal", "kv-sst", "idb"]
  console.log(`docs=${state.docs} of total=${state.total} runs=${state.runs} concurrency=${state.concurrency} edits=${state.edits}`)
  console.log("")
  console.log(`write ${state.total} docs, once per shape`)
  console.log("shape        write ms  ingest ms   updates  update B    files B  wal rows")
  for (const shape of shapes) {
    const row = state.writes.find((write) => write.shape === shape)
    if (!row) continue
    console.log(
      `${shape.padEnd(10)} ${ms(row.writeMs)} ${ms(row.ingestMs)} ${String(row.updates).padStart(9)} ${String(row.updateBytes).padStart(9)} ${String(row.opfsBytes).padStart(10)} ${String(row.walRecords).padStart(9)}`,
    )
  }
  console.log("")
  console.log(
    `load ${state.docs} random docs of ${state.total}, median of the runs. first/all include opening storage. doc sum adds each doc's open time across the concurrent loads, so it can exceed the wall clock.`,
  )
  console.log("shape      pass   open ms   first ms    all ms   doc sum   doc/n    doc max   checked")
  for (const shape of shapes) {
    for (const pass of ["cold", "warm"] as const) {
      const rows = state.loads
        .filter((load) => load.shape === shape)
        .map((load) => load.passes.find((item) => item.pass === pass))
        .filter((item): item is LoadPass => item !== undefined)
      if (rows.length === 0) continue
      const cell = (pick: (row: LoadPass) => number) => ms(median(rows.map(pick)))
      console.log(
        `${shape.padEnd(10)} ${pass.padEnd(6)} ${cell((row) => row.openMs)} ${cell((row) => row.firstMs)} ${cell((row) => row.allMs)} ${cell((row) => row.docMsSum)} ${ms(median(rows.map((row) => row.docMsSum / Math.max(1, row.checked))))} ${cell((row) => row.docMsMax)} ${String(Math.min(...rows.map((row) => row.checked))).padStart(9)}`,
      )
    }
  }
  console.log("")
  console.log("per run (cold all ms / warm all ms @ position in that run's order)")
  for (const shape of shapes) {
    const text = state.loads
      .filter((load) => load.shape === shape)
      .map((load) => {
        const cold = load.passes.find((pass) => pass.pass === "cold")!.allMs.toFixed(0)
        const warm = load.passes.find((pass) => pass.pass === "warm")!.allMs.toFixed(0)
        return `${cold}/${warm}@${load.order}`
      })
      .join("  ")
    console.log(`${shape.padEnd(10)} ${text}`)
  }
}

async function waitForVite(port: number): Promise<void> {
  const deadline = Date.now() + 60_000
  let last = "vite not up"
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/bench/`)
      if (res.ok) return
      last = `status ${res.status}`
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
    }
    await sleep(200)
  }
  throw new Error(last)
}

async function main(): Promise<number> {
  const port = await freePort()
  const debugPort = await freePort()
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "yjs-load-bench-"))
  const pageUrl = `http://127.0.0.1:${port}/bench/?auto=1&docs=${docs}&runs=${runs}&concurrency=${concurrency}&edits=${edits}`
  const vite = spawn(
    "pnpm",
    ["exec", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: exampleDir, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  )
  vite.unref()
  let viteLog = ""
  vite.stdout?.on("data", (chunk: Buffer) => {
    viteLog += chunk.toString()
  })
  vite.stderr?.on("data", (chunk: Buffer) => {
    viteLog += chunk.toString()
  })
  const chrome = spawn(
    chromePath(),
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-dev-shm-usage",
      "--enable-features=FileSystemAccessAPI",
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`,
      pageUrl,
    ],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] },
  )
  chrome.unref()
  let chromeLog = ""
  chrome.stderr?.on("data", (chunk: Buffer) => {
    chromeLog += chunk.toString()
  })

  const deadline = Date.now() + timeoutMs
  let lastStatus = ""
  try {
    await waitForVite(port)
    console.log(`url ${pageUrl}`)
    while (Date.now() < deadline) {
      let socket: string
      try {
        socket = await pageSocket(debugPort, `http://127.0.0.1:${port}/bench/`)
      } catch (err) {
        lastStatus = err instanceof Error ? err.message : String(err)
        await sleep(500)
        continue
      }
      let status = ""
      let result: BenchState | { error: string } | null = null
      try {
        status = (await devtoolsCall(socket, "Runtime.evaluate", {
          expression: "window.__BENCH_STATUS ?? ''",
          returnByValue: true,
        })) as string
        result = (await devtoolsCall(socket, "Runtime.evaluate", {
          expression: "window.__BENCH ?? null",
          returnByValue: true,
        })) as BenchState | { error: string } | null
      } catch (err) {
        lastStatus = err instanceof Error ? err.message : String(err)
        await sleep(500)
        continue
      }
      if (status && status !== lastStatus) {
        console.log(status)
        lastStatus = status
      }
      if (result && "error" in result) {
        console.error(result.error)
        return 1
      }
      if (result && "loads" in result && result.nextRun >= result.runs) {
        report(result)
        const out = process.env.BENCH_OUT
        if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2))
        return 0
      }
      await sleep(1000)
    }
    console.error(`bench timed out after ${timeoutMs}ms\nlast status: ${lastStatus}\nvite:\n${viteLog.slice(-2000)}\nchrome:\n${chromeLog.slice(-2000)}`)
    return 1
  } finally {
    killProcess(chrome)
    killProcess(vite)
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

process.exitCode = await main()
