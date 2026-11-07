/**
 * One Vite production build, two uses: the bench page the runner serves
 * (minified production code, no dev-server optimizer reloading mid-run),
 * and one entry per bundle-size row, whose emitted files size.ts measures.
 * A bundle that fails to emit or boot kv's SharedWorker therefore fails the
 * bench, not only the size table.
 */
import { readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite";
import wasm from "vite-plugin-wasm";
import { SIZE_ROWS } from "../size/rows.ts";

export const BENCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(BENCH_DIR, ".out");

/** Static imports of each emitted chunk, from the bundler's own metadata. */
export type BuildOutput = {
  readonly outDir: string;
  /** Size row id → its entry chunk's file name. */
  readonly rowEntries: ReadonlyMap<string, string>;
  /** Chunk file name → statically imported chunk file names. */
  readonly staticImports: ReadonlyMap<string, readonly string[]>;
};

const ROW_PREFIX = "\0size-row:";

export async function buildBench(opts: { quiet?: boolean } = {}): Promise<BuildOutput> {
  rmSync(OUT_DIR, { recursive: true, force: true });
  const staticImports = new Map<string, string[]>();
  const rowEntries = new Map<string, string>();

  const rows: Plugin = {
    name: "bench-size-rows",
    resolveId(id) {
      return id.startsWith("size-row:") ? `\0${id}` : undefined;
    },
    load(id) {
      if (!id.startsWith(ROW_PREFIX)) return undefined;
      const row = SIZE_ROWS.find((r) => r.id === id.slice(ROW_PREFIX.length));
      return row?.source;
    },
    generateBundle(_options, bundle) {
      for (const out of Object.values(bundle)) {
        if (out.type !== "chunk") continue;
        staticImports.set(out.fileName, [...out.imports]);
        if (out.isEntry && out.facadeModuleId?.startsWith(ROW_PREFIX)) {
          rowEntries.set(out.facadeModuleId.slice(ROW_PREFIX.length), out.fileName);
        }
      }
    },
  };

  await build({
    configFile: false,
    root: path.join(BENCH_DIR, "page"),
    logLevel: opts.quiet ? "warn" : "info",
    plugins: [wasm(), rows],
    worker: { format: "es", plugins: () => [wasm()] },
    build: {
      outDir: OUT_DIR,
      emptyOutDir: true,
      target: "es2022",
      minify: true,
      sourcemap: false,
      modulePreload: false,
      reportCompressedSize: false,
      chunkSizeWarningLimit: 4096,
      rollupOptions: {
        input: {
          index: path.join(BENCH_DIR, "page/index.html"),
          ...Object.fromEntries(SIZE_ROWS.map((r) => [`size-${r.id}`, `size-row:${r.id}`])),
        },
        preserveEntrySignatures: "strict",
      },
    },
  });

  // Today's bug class: a worker or module inlined as a data: URL cannot resolve its imports.
  for (const file of readdirSync(path.join(OUT_DIR, "assets"))) {
    if (!file.endsWith(".js")) continue;
    if (readFileSync(path.join(OUT_DIR, "assets", file), "utf8").includes("data:text/javascript")) {
      throw new Error(`${file} inlines a module as a data: URL; its relative imports cannot resolve`);
    }
  }
  return { outDir: OUT_DIR, rowEntries, staticImports };
}
