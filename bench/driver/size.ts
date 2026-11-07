/**
 * Bundle size from the bundler's own output. For each size row:
 *
 * - at import: the entry chunk and its static imports (bundler metadata),
 *   the bytes downloaded before the import resolves;
 * - after open: plus every emitted file those reference by name (dynamic
 *   imports, the SharedWorker chunk, its imports, `.wasm` assets),
 *   followed transitively. Hashed file names make a name reference exact.
 *
 * Each file is compressed on its own, as a server sends it.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import type { BuildOutput } from "./build.ts";
import { SIZE_ROWS } from "../size/rows.ts";

export type Bytes3 = { raw: number; gzip: number; brotli: number };
export type SizeResult = {
  id: string;
  note: string;
  budget?: number;
  atImport: Bytes3;
  afterOpen: Bytes3;
  files: { name: string; deferred: boolean; raw: number; brotli: number }[];
};

export function measureSizes(build: BuildOutput): SizeResult[] {
  const assetsDir = path.join(build.outDir, "assets");
  const names = readdirSync(assetsDir);
  const cache = new Map<string, Bytes3 & { text?: string }>();
  const sizeOf = (name: string) => {
    let s = cache.get(name);
    if (!s) {
      const bytes = readFileSync(path.join(assetsDir, name));
      s = {
        raw: bytes.byteLength,
        gzip: gzipSync(bytes, { level: 9 }).byteLength,
        brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength,
        ...(name.endsWith(".js") ? { text: bytes.toString("utf8") } : {}),
      };
      cache.set(name, s);
    }
    return s;
  };

  return SIZE_ROWS.map((row) => {
    const entry = build.rowEntries.get(row.id);
    if (!entry) throw new Error(`size row ${row.id}: no entry chunk emitted`);
    const atImport = new Set<string>();
    const visitStatic = (file: string) => {
      if (atImport.has(file)) return;
      atImport.add(file);
      for (const dep of build.staticImports.get(file) ?? []) visitStatic(dep);
    };
    visitStatic(entry);

    const all = new Set<string>();
    const visitRefs = (file: string) => {
      const base = path.basename(file);
      if (all.has(base)) return;
      all.add(base);
      const text = sizeOf(base).text;
      if (text === undefined) return;
      for (const other of names) if (other !== base && text.includes(other)) visitRefs(other);
    };
    for (const f of atImport) visitRefs(f);

    const atImportBases = new Set([...atImport].map((f) => path.basename(f)));
    const sum = (files: Iterable<string>): Bytes3 => {
      const t = { raw: 0, gzip: 0, brotli: 0 };
      for (const f of files) {
        const s = sizeOf(f);
        t.raw += s.raw;
        t.gzip += s.gzip;
        t.brotli += s.brotli;
      }
      return t;
    };
    if (row.kv) {
      const wasm = [...all].filter((f) => f.endsWith(".wasm"));
      const worker = [...all].filter((f) => f.startsWith("shared-worker"));
      if (wasm.length !== 1 || worker.length !== 1) {
        throw new Error(`size row ${row.id}: expected one .wasm and one shared-worker chunk, got ${[...all].join(", ")}`);
      }
    }
    return {
      id: row.id,
      note: row.note,
      ...(row.budget !== undefined ? { budget: row.budget } : {}),
      atImport: sum(atImportBases),
      afterOpen: sum(all),
      files: [...all].sort().map((name) => ({
        name,
        deferred: !atImportBases.has(name),
        raw: sizeOf(name).raw,
        brotli: sizeOf(name).brotli,
      })),
    };
  });
}

export function formatSizes(rows: readonly SizeResult[]): string {
  const kb = (n: number) => (n / 1000).toFixed(1);
  const lines = [
    "Bundle size, kB (1000 bytes). Each file compressed on its own. After open = + SharedWorker, wasm, lazy chunks.",
    "",
    "| row | at import brotli | after open raw | after open gzip | after open brotli | budget |",
    "|---|---:|---:|---:|---:|---:|",
  ];
  for (const r of rows) {
    const over = r.budget !== undefined && r.afterOpen.brotli > r.budget ? " OVER" : "";
    lines.push(
      `| ${r.id} | ${kb(r.atImport.brotli)} | ${kb(r.afterOpen.raw)} | ${kb(r.afterOpen.gzip)} | ${kb(r.afterOpen.brotli)} | ${r.budget === undefined ? "" : kb(r.budget) + over} |`,
    );
  }
  lines.push("");
  for (const r of rows) {
    lines.push(`${r.id}: ${r.note}`);
    for (const f of r.files) lines.push(`  ${f.deferred ? "later " : "import"} ${f.name}  ${kb(f.raw)} raw, ${kb(f.brotli)} br`);
  }
  return lines.join("\n");
}
