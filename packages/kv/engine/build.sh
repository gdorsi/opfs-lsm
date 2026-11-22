#!/bin/sh
# Builds packages/kv/wasm/engine.wasm with the AssemblyScript compiler that
# packages/kv/package.json pins. A compiler bump changes the bytes: rebuild
# and commit the binary with the new version, and update ASC_VERSION.
set -e
ASC_VERSION=0.28.20
cd "$(dirname "$0")/.."
asc=node_modules/.bin/asc
found=$("$asc" --version)
if [ "$found" != "Version $ASC_VERSION" ]; then
  echo "engine.wasm is built with asc $ASC_VERSION, found: $found. Run pnpm install." >&2
  exit 1
fi
# Both paths stay relative to packages/kv: asc names a module by the path it
# was reached by, and an absolute runtime path would load alloc.ts twice.
"$asc" engine/index.ts --runtime engine/runtime --use abort= --noAssert \
  --optimizeLevel 3 --shrinkLevel 2 --outFile wasm/engine.wasm
