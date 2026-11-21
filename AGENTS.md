# AGENTS.md

The project is a prototype. Backward compatibility doesn't matter yet, and constraints can change when that buys performance.

Design principles for our packages:

- Read and write performance come first. Bundle size also matters.
- We are building a Db for web apps, benchmarks are a good help but above all we must favor things that help building a better UX
- Keep it simple.
- Consistency is guaranteed. Persistence is not.
- Before adding a cache, check whether an architectural change gets the same performance.
- If you can't, evaulate if the gain is worth the cost of having a cache

## Examples

The apps under `examples/` show how to build a web app on our packages, and test those packages the way an app uses them.

- Use each dependency the way its docs recommend. No custom workarounds.
- Build a complete, working web app with a polished UX.
- Make it look good, like a product someone would ship, not a test page.
- Write reference code: clean, small and idiomatic. People copy examples.
- Store data with our packages only. No switch to another storage, and no hooks, marks or options that exist for a benchmark.
- Keep the app's core testable without the UI, and test it. A test that fails because of our package is a bug in the package.

## Format changes

A change that makes stored data read differently, such as a kv or docstore format or the LinearLite demo's schema, raises `DATA_VERSION` in `examples/linearlite-docstore/src/main.tsx` and in `examples/linearlite-tanstackdb/src/app/open.ts`. Each demo then opens a fresh database for returning visitors and frees the old one.

## Benchmarks

`bench/` measures the packages, never the example apps. A new access pattern becomes a goal on a dataset, with one workload owning each pattern (see [bench/README.md](bench/README.md), "Goal workloads"). The results tables of [docs/benchmarks.md](docs/benchmarks.md) are generated from the runs committed under [docs/results/](docs/results/): add a row to `bench/docs-tables.ts` and run `node bench/cli.ts docs` (see bench/README.md, "Publishing a run").

## Worktrees

Create worktrees inside `.claude/worktrees/` in the repository, never change code in the main worktree.

## Dev servers

`pnpm dev <site|example>` starts the docs site or an example app, or reuses the one this checkout already runs. The server keeps running after your session ends, and the command prints its URL and log file.

`pnpm tunnel <site|example>` builds the app, serves the build and prints a public HTTPS address for it, to open the app on a phone or another machine. It runs until it is stopped, and it needs `cloudflared` on the PATH.

## docs/design.md

[docs/design.md](docs/design.md) describes the kv engine as it is now: the formats on disk, the protocols, the invariants and the platform assumptions. Keep it a reference:

- **Describe the present only.** No history, no "used to", no story of how a number was tuned. When behavior changes, rewrite the paragraph instead of adding one next to it.
- **No measurements.** Benchmark numbers, sweeps and comparison tables go in `docs/research/`. The design doc states the choice and gives at most one sentence of why.
- **No tour of the code.** No file paths, function names or class names. Name only what a user or the disk sees: API options, store and file names, lock and channel names, error names.
- **Say each fact once**, in the section that owns it. Other sections link to it.
- **A mechanism gets what a reimplementer needs**: the format, the steps, the invariant. Proofs, liveness arguments and test descriptions go in `docs/verification.md` or `docs/research/`.
- **Edit in place.** A change that adds lines should cut lines elsewhere, or move a topic to its own file and link it.

## Verification

[docs/verification.md](docs/verification.md) is the source of truth for which skill to run, the command order, and what a pass looks like. The skills under `.agents/skills/` hold the property list and the feature recipes.

## Static checks

`pnpm static` runs oxlint (`.oxlintrc.json`), `check:docs`, and fallow dead-code detection (`.fallowrc.json`). CI runs all three in the `static` job. If fallow reports a new script entry point as unused, add it to `entry` in `.fallowrc.json`. oxlint rejects `fake-indexeddb` imports under `bench/`, which must run on real IndexedDB; see bench/README.md. The repository's own oxlint rules are in `scripts/oxlint-plugin.mjs`.
