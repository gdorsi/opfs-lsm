#!/bin/sh
# Builds packages/kv/wasm/engine.wasm with Zig 0.17.1. wasm-opt is used when
# installed (brew install binaryen).
set -e
cd "$(dirname "$0")"
zig_version=0.17.1
if [ "$(zig version)" != "$zig_version" ]; then
  echo "engine/build.sh: needs Zig $zig_version, found $(zig version)" >&2
  exit 1
fi
out=${1:-../wasm/engine.wasm}
optimize=${OPTIMIZE:-ReleaseFast}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
zig build-exe src/main.zig -target wasm32-freestanding -fno-entry -fstrip -O "$optimize" \
  --export=input_ptr --export=result_ptr --export=result_len --export=encode_sst \
  --export=scan_block_contains --export=merge_open --export=merge_pump \
  --export=merge_feed --export=merge_close \
  --cache-dir "$tmp/cache" --global-cache-dir "$tmp/global" -femit-bin="$tmp/engine.wasm"
if [ "${WASM_OPT:-1}" = 1 ] && command -v wasm-opt >/dev/null; then
  wasm-opt -O3 --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
    --enable-mutable-globals --enable-multivalue --enable-reference-types "$tmp/engine.wasm" -o "$out"
else
  cp "$tmp/engine.wasm" "$out"
fi
