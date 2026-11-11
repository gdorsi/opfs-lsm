import { readFileSync } from "node:fs";

const [file, mode = "summary"] = process.argv.slice(2);
const { traceEvents: ev } = JSON.parse(readFileSync(file!, "utf8")) as { traceEvents: any[] };

const threadName = new Map<string, string>();
for (const e of ev) if (e.ph === "M" && e.name === "thread_name") threadName.set(`${e.pid}:${e.tid}`, e.args.name);

const nav = ev.find((e) => e.name === "navigationStart" && e.args?.data?.isLoadingMainFrame && String(e.args?.data?.documentLoaderURL ?? "").includes("/issues"));
const firstRows = ev.find((e) => e.name === "linearlite:first-rows");
if (!nav || !firstRows) throw new Error(`nav ${!!nav} first-rows ${!!firstRows}`);
const t0 = nav.ts;
const t1 = firstRows.ts;
const ms = (us: number) => Math.round(us / 100) / 10;
console.log(`navigationStart -> first-rows: ${ms(t1 - t0)} ms`);

interface Node { id: number; parent?: number; callFrame: { functionName: string; url: string; lineNumber: number } }
interface Profile { key: string; nodes: Map<number, Node>; samples: { node: number; ts: number }[]; startTime: number; last: number }
const profiles = new Map<string, Profile>();
for (const e of ev) {
  if (e.name === "Profile") {
    profiles.set(`${e.pid}:${e.id}`, { key: `${e.pid}:${e.tid}`, nodes: new Map(), samples: [], startTime: e.args.data.startTime, last: e.args.data.startTime });
  }
}
for (const e of ev.filter((x) => x.name === "ProfileChunk").sort((a, b) => a.ts - b.ts)) {
  const p = profiles.get(`${e.pid}:${e.id}`);
  if (!p) continue;
  const d = e.args.data;
  for (const n of d.cpuProfile?.nodes ?? []) p.nodes.set(n.id, n);
  const samples: number[] = d.cpuProfile?.samples ?? [];
  const deltas: number[] = d.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    p.last += deltas[i] ?? 0;
    p.samples.push({ node: samples[i]!, ts: p.last });
  }
}

function pkg(url: string, fn: string): string {
  if (!url) return fn.startsWith("(") ? fn : "(native)";
  if (url.includes("kv") && (url.includes("worker") || url.includes("host"))) return "kv-worker";
  const m = url.match(/assets\/([^/]+?)-[A-Za-z0-9_-]{8}\.js/);
  return m ? m[1]! : url.replace(/^https?:\/\/[^/]+/, "").slice(0, 60);
}

for (const p of profiles.values()) {
  const inWin = p.samples.filter((s, i) => s.ts >= t0 && s.ts <= t1 && i > 0);
  if (inWin.length < 20) continue;
  const name = threadName.get(p.key) ?? p.key;
  const self = new Map<string, number>();
  const byPkg = new Map<string, number>();
  const inclusive = new Map<string, number>();
  const buckets = new Map<number, Map<string, number>>();
  let total = 0;
  for (let i = 0; i < p.samples.length; i++) {
    const s = p.samples[i]!;
    if (s.ts < t0 || s.ts > t1 || i === 0) continue;
    const dt = s.ts - p.samples[i - 1]!.ts;
    const n = p.nodes.get(s.node);
    if (!n) continue;
    const f = n.callFrame;
    if (f.functionName === "(idle)") continue;
    total += dt;
    const label = `${f.functionName || "(anon)"} ${pkg(f.url, f.functionName)}:${f.lineNumber + 1}`;
    self.set(label, (self.get(label) ?? 0) + dt);
    const pk = pkg(f.url, f.functionName);
    byPkg.set(pk, (byPkg.get(pk) ?? 0) + dt);
    const seen = new Set<string>();
    for (let cur: Node | undefined = n; cur; cur = cur.parent ? p.nodes.get(cur.parent) : undefined) {
      const cf = cur.callFrame;
      const l = `${cf.functionName || "(anon)"} ${pkg(cf.url, cf.functionName)}:${cf.lineNumber + 1}`;
      if (seen.has(l)) continue;
      seen.add(l);
      inclusive.set(l, (inclusive.get(l) ?? 0) + dt);
    }
    const b = Math.floor((s.ts - t0) / 100_000);
    const bm = buckets.get(b) ?? new Map();
    bm.set(pk, (bm.get(pk) ?? 0) + dt);
    buckets.set(b, bm);
  }
  const top = (m: Map<string, number>, k: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(([l, v]) => `    ${String(ms(v)).padStart(7)} ms  ${l}`).join("\n");
  console.log(`\n== ${name} (${p.key}) busy ${ms(total)} ms of ${ms(t1 - t0)} ms`);
  console.log("  by package:\n" + top(byPkg, 12));
  console.log("  self:\n" + top(self, mode === "full" ? 40 : 20));
  if (mode === "full") console.log("  inclusive:\n" + top(inclusive, 50));
  console.log("  timeline (100 ms buckets, busy ms and top packages):");
  for (const [b, m] of [...buckets].sort((a, b) => a[0] - b[0])) {
    const sum = [...m.values()].reduce((a, c) => a + c, 0);
    const tops = [...m].sort((a, c) => c[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${ms(v)}`).join(", ");
    console.log(`    ${String(b * 100).padStart(5)} ms  ${String(ms(sum)).padStart(5)}  ${tops}`);
  }
}

console.log("\n== network (relative to navigationStart)");
const sends = new Map<string, any>();
for (const e of ev) {
  if (e.name === "ResourceSendRequest") sends.set(e.args.data.requestId, e);
  if (e.name === "ResourceFinish") {
    const s = sends.get(e.args.data.requestId);
    if (s && s.ts >= t0 && s.ts <= t1) console.log(`  ${String(ms(s.ts - t0)).padStart(7)} -> ${String(ms(e.ts - t0)).padStart(7)}  ${s.args.data.url.replace(/^https?:\/\/[^/]+/, "").slice(0, 90)}`);
  }
}
const marks = ev.filter((e) => e.cat?.includes("user_timing") && e.ts >= t0 && e.ts <= t1 + 2_000_000);
for (const m of marks) console.log(`  mark ${String(ms(m.ts - t0)).padStart(7)}  ${m.name}`);
