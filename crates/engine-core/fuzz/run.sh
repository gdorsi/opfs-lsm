#!/bin/sh
# Run one cargo-fuzz target for a while, starting from its corpus.
#
#   crates/engine-core/fuzz/run.sh <target> [seconds]
#
# Targets: decode_sst, scan_block_contains, compact. Seconds default to 600.
# Needs nightly and cargo-fuzz (`cargo install cargo-fuzz`). New corpus
# inputs land in fuzz/corpus/<target>/ next to the committed `seed-*` files
# (git ignores them); a crash lands in fuzz/artifacts/<target>/, and
# `cargo +nightly fuzz run <target> <file>` replays it.
# ENGINE_FUZZ_KNOWN=1 also feeds inputs that reach a reported bug.
set -eu
target=${1:?target}
seconds=${2:-600}
cd "$(dirname "$0")/.."
exec cargo +nightly fuzz run --debug-assertions "$target" "fuzz/corpus/$target" -- \
  -max_total_time="$seconds" -timeout=10 -rss_limit_mb=2048 -malloc_limit_mb=256 -print_final_stats=1
