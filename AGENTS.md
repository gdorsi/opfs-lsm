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

## Verification

[docs/verification.md](docs/verification.md) is the source of truth for which skill to run, the command order, and what a pass looks like. Follow that page. The skills under `.agents/skills/` hold the property list and the feature recipes.

## Static checks

`pnpm static` runs oxlint (`.oxlintrc.json`, correctness rules) and fallow dead-code detection (`.fallowrc.json`). CI runs both in the `static` job. Add a new script entry point to `entry` in `.fallowrc.json` if fallow reports it as unused. Benchmarks live in `bench/`; see bench/README.md.
