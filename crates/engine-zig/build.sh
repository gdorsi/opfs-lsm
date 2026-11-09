#!/bin/sh
# Builds engine_small.wasm and engine_fast.wasm next to this script. Needs zig 0.16.
set -e
cd "$(dirname "$0")"
zig build-exe engine.zig -target wasm32-freestanding -fno-entry -rdynamic -O ReleaseSmall -fstrip -femit-bin=engine_small.wasm
zig build-exe engine.zig -target wasm32-freestanding -fno-entry -rdynamic -O ReleaseFast -fstrip -femit-bin=engine_fast.wasm
