# Agents.md

We are still in the prototyping phase of the project.

Don't care about backward compatibility yet, and we can change the constraints if it would give us more performance.

Design principles:
- read/write performance above everything
- KISS
- consistency should be guaranteed, persistence not
- before adding a new cache, check if we can achieve the same performance with an architectural change
- be mindful of what have in Rust and what in Typescript, don't just "go with the flow" and accept what's already there

Never use fake-indexeddb on benchmarks plz

## docs/design.md

[docs/design.md](docs/design.md) describes the kv engine as it is now: the formats on disk, the protocols, the invariants and the platform assumptions. It is reference, modelled on [redb's design doc](https://github.com/cberner/redb/blob/master/docs/design.md). Keep it that way:

- **Describe the present only.** No history, no "used to", no "since removed", no story of how a number was tuned. When behavior changes, rewrite the paragraph. Don't add a paragraph next to it.
- **No measurements.** Benchmark numbers, sweeps and comparison tables go in `docs/research/`. The design doc states the choice and gives at most one sentence of why.
- **No tour of the code.** No file paths, function names or class names. Name only what a user or the disk sees: API options, store and file names, lock and channel names, error names.
- **Say each fact once**, in the section that owns it. Other sections link to it.
- **A mechanism gets what a reimplementer needs**: the format, the steps, the invariant. Proofs, liveness arguments and test descriptions go in `docs/verification.md` or `docs/research/`.
- **Edit in place and stay under 700 lines.** A change that adds lines should cut lines elsewhere. If the doc cannot stay under the limit, move a topic out to its own file and link it.
- **Keep the heading names.** Code comments and other docs cite them as `design.md, "Recovery"`. If you rename a heading, update the citations.

## Verification

[docs/verification.md](docs/verification.md) is the source of truth for which skill to run, the command order, and what a pass looks like. Follow that page. The skills under `.agents/skills/` hold the property list and the feature recipes.

## Static checks

`pnpm static` runs oxlint (`.oxlintrc.json`, correctness rules) and fallow dead-code detection (`.fallowrc.json`). CI runs both in the `static` job. Add a new script entry point to `entry` in `.fallowrc.json` if fallow reports it as unused. Benchmarks live in `bench/`; see bench/README.md.
