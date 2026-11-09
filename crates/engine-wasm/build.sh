#!/bin/sh
# Builds packages/kv/wasm/engine.wasm. Needs nightly with rust-src
# (`rustup component add rust-src --toolchain nightly`); wasm-opt is used
# when installed.
set -e
cd "$(dirname "$0")/../.."
# Rebuilding std with immediate-abort drops the panic formatting machinery.
# std's optimize_for_size feature saves another 1.6 kB gzip but its smaller
# sort makes encode_sst about 60% slower, so it stays off.
RUSTFLAGS="-Zunstable-options -Cpanic=immediate-abort" cargo +nightly build -p engine-wasm \
  --target wasm32-unknown-unknown --release \
  -Zbuild-std=std,panic_abort
out=packages/kv/wasm/engine.wasm
wasm=target/wasm32-unknown-unknown/release/engine_wasm.wasm
if command -v wasm-opt >/dev/null; then
  wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
    --enable-mutable-globals --enable-multivalue --enable-reference-types "$wasm" -o "$out"
else
  cp "$wasm" "$out"
fi
