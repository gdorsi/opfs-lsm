#!/bin/sh
# Builds packages/kv/wasm/engine.wasm on stable Rust. wasm-opt is used when
# installed (brew install binaryen) and saves about 3 kB gzipped.
set -e
cd "$(dirname "$0")/../.."
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
cargo build -p engine-wasm --target wasm32-unknown-unknown --release
out=packages/kv/wasm/engine.wasm
wasm=target/wasm32-unknown-unknown/release/engine_wasm.wasm
if command -v wasm-opt >/dev/null; then
  wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
    --enable-mutable-globals --enable-multivalue --enable-reference-types "$wasm" -o "$out"
else
  cp "$wasm" "$out"
fi
