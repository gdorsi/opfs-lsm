/**
 * Minified browser JS gzip for Dexie and @opfs-lsm/kv.
 * The wasm file is counted on its own and is not inside the JS bundle.
 *
 *   pnpm --filter @opfs-lsm/kv build && pnpm exec tsx scripts/measure-bundle.ts
 */
import { gzipSync } from "node:zlib";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const kvRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(contents: string, sourcefile: string, outfile: string) {
  await esbuild.build({
    stdin: {
      contents,
      resolveDir: kvRoot,
      sourcefile,
      loader: "ts",
    },
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    outfile,
    logLevel: "silent",
  });
  const raw = readFileSync(outfile);
  return { raw: raw.byteLength, gz: gzipSync(raw).byteLength };
}

const dist = path.join(kvRoot, "dist/index.js");
if (!existsSync(dist)) {
  console.error("missing packages/kv/dist/index.js — run pnpm --filter @opfs-lsm/kv build");
  process.exit(1);
}

const outDir = mkdtempSync(path.join(tmpdir(), "opfs-lsm-bundle-"));
try {
  const dexie = await bundle(
    'import Dexie from "dexie";\nexport const Db = Dexie;\n',
    "dexie-entry.ts",
    path.join(outDir, "dexie.js"),
  );
  const kv = await bundle(
    'export { openDb, prefixBound, ConflictError } from "./dist/index.js";\n',
    "kv-entry.ts",
    path.join(outDir, "kv.js"),
  );
  const wasmPath = path.join(kvRoot, "wasm/engine_wasm_bg.wasm");
  const wasmRaw = existsSync(wasmPath) ? readFileSync(wasmPath).byteLength : 0;
  console.log(
    JSON.stringify(
      {
        dexie_js_raw: dexie.raw,
        dexie_js_gz: dexie.gz,
        kv_js_raw: kv.raw,
        kv_js_gz: kv.gz,
        kv_wasm_raw: wasmRaw,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
