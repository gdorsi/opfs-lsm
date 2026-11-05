/**
 * Drive bench/index.html in headless Chrome (OPFS + SharedWorker).
 *
 *   pnpm --filter @opfs-lsm/kv build
 *   pnpm --filter @opfs-lsm/example-automerge bench:load
 *   DOCS=5000 RUNS=3 pnpm --filter @opfs-lsm/example-automerge bench:load
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
const timeoutMs = Number(process.env.BENCH_TIMEOUT_MS ?? 30 * 60 * 1000)
const exampleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

type LoadPass = {
  pass: "cold" | "warm"
  openMs: number
  firstMs: number
  allMs: number
  checked: number
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

type WriteResult = {
  shape: string
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
}

type BenchState = {
  docs: number
  runs: number
  concurrency: number
  writes: WriteResult[]
  loads: { shape: string; order: number; passes: LoadPass[] }[]
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
  console.log(`docs=${state.docs} runs=${state.runs} concurrency=${state.concurrency}`)
  console.log("")
  console.log("write, median of the runs. payload and file bytes are from the last run, the one the loads read.")
  console.log(
    "shape      create ms   flush ms  ingest ms  payload B   files B  wal rows  idb rows  generation",
  )
  for (const shape of shapes) {
    const rows = state.writes.filter((row) => row.shape === shape)
    const last = rows[rows.length - 1]
    if (!last) continue
    console.log(
      `${shape.padEnd(10)} ${ms(median(rows.map((row) => row.createMs)))} ${ms(median(rows.map((row) => row.flushMs)))} ${ms(median(rows.map((row) => row.ingestMs)))} ${String(last.saveBytes).padStart(10)} ${String(last.opfsBytes).padStart(8)} ${String(last.walRecords).padStart(9)} ${String(last.idbRecords).padStart(9)} ${String(last.generation).padStart(11)}`,
    )
  }
  console.log("")
  console.log(
    "load, median of the runs. first/all include opening storage. range and decode are sums across the concurrent loads, so they can exceed the wall clock.",
  )
  console.log(
    "shape      pass   open ms   first ms    all ms   range sum   range/n  decode sum  decodes",
  )
  for (const shape of shapes) {
    for (const pass of ["cold", "warm"] as const) {
      const rows = state.loads
        .filter((load) => load.shape === shape)
        .map((load) => load.passes.find((item) => item.pass === pass))
        .filter((item): item is LoadPass => item !== undefined)
      if (rows.length === 0) continue
      const cell = (pick: (row: LoadPass) => number) => ms(median(rows.map(pick)))
      const rangeN = median(rows.map((row) => row.rangeN))
      const rangeSum = median(rows.map((row) => row.rangeMs))
      console.log(
        `${shape.padEnd(10)} ${pass.padEnd(6)} ${cell((row) => row.openMs)} ${cell((row) => row.firstMs)} ${cell((row) => row.allMs)} ${ms(rangeSum)} ${ms(rangeN === 0 ? 0 : rangeSum / rangeN)} ${cell((row) => row.decodeMs)} ${String(median(rows.map((row) => row.decodeN))).padStart(8)}`,
      )
    }
  }
  console.log("")
  console.log("per run (cold all ms / warm all ms), in the order measured on that page")
  for (const shape of shapes) {
    const rows = state.loads.filter((load) => load.shape === shape)
    const text = rows
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "am-load-bench-"))
  const pageUrl = `http://127.0.0.1:${port}/bench/?auto=1&docs=${docs}&runs=${runs}&concurrency=${concurrency}`
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
