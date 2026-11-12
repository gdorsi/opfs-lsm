# AGENTS.md

The project is a prototype. Backward compatibility doesn't matter yet, and constraints can change when that buys performance.

Design principles:

- Read and write performance come first.
- Keep it simple.
- Consistency is guaranteed. Persistence is not.
- Before adding a cache, check whether an architectural change gets the same performance.
- Decide on purpose what lives in Rust and what lives in TypeScript. Don't keep a split only because it is already there.

## Worktrees

Create worktrees inside `.claude/worktrees/` in the repository, never in the parent directory or elsewhere (for example `.claude/worktrees/my-branch`).

## docs/design.md

[docs/design.md](docs/design.md) describes the kv engine as it is now: the formats on disk, the protocols, the invariants and the platform assumptions. Keep it a reference:

- **Describe the present only.** No history, no "used to", no story of how a number was tuned. When behavior changes, rewrite the paragraph instead of adding one next to it.
- **No measurements.** Benchmark numbers, sweeps and comparison tables go in `docs/research/`. The design doc states the choice and gives at most one sentence of why.
- **No tour of the code.** No file paths, function names or class names. Name only what a user or the disk sees: API options, store and file names, lock and channel names, error names.
- **Say each fact once**, in the section that owns it. Other sections link to it.
- **A mechanism gets what a reimplementer needs**: the format, the steps, the invariant. Proofs, liveness arguments and test descriptions go in `docs/verification.md` or `docs/research/`.
- **Edit in place.** A change that adds lines should cut lines elsewhere, or move a topic to its own file and link it.

Code and docs cite headings as `design.md, "Recovery"`. `pnpm check:docs` fails when a citation names a missing heading, when the doc passes 700 lines, or when it names a source file.

## Verification

[docs/verification.md](docs/verification.md) is the source of truth for which skill to run, the command order, and what a pass looks like. The skills under `.agents/skills/` hold the property list and the feature recipes.

## Static checks

`pnpm static` runs oxlint (`.oxlintrc.json`), `check:docs`, and fallow dead-code detection (`.fallowrc.json`). CI runs all three in the `static` job. If fallow reports a new script entry point as unused, add it to `entry` in `.fallowrc.json`. oxlint rejects `fake-indexeddb` imports under `bench/`, which must run on real IndexedDB; see bench/README.md.
