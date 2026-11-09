# Review rubric

The repository is a prototype storage engine for the browser: a key-value store on OPFS with a Rust core
compiled to wasm and a TypeScript host, plus a collections layer on top. Backward compatibility does not
matter yet. Judge the change by the project's own principles, in this order.

## Principles

1. **Read and write performance above everything.** A change that slows a hot path (put, get, scans, WAL
   append, ingest, flush, compaction, cross-tab messaging) without a measured reason is a blocker. A claim
   that something is faster needs a benchmark run, not an argument.
2. **KISS.** Prefer the simpler design. Extra layers, options or indirection that nothing needs are nits,
   unless they make a hot path slower (then rule 1 applies).
3. **Consistency is guaranteed; persistence is not.** A write that was acknowledged must be visible to
   every later read, in every tab, and a view must stay a consistent snapshot. Losing recent writes on a
   crash is acceptable; returning stale, torn or reordered data is not.
4. **No new cache before an architectural change.** A new cache, memo or duplicate index is a blocker
   unless the change shows that no architectural change reaches the same performance.
5. **Rust versus TypeScript is a decision.** Logic placed on one side of the wasm boundary only because
   similar code already lives there deserves a finding. Data crossing the boundary on a hot path more
   often than needed is a blocker.

## Blockers

Raise these as `blocker`:

- Correctness bugs: wrong results, lost acknowledged writes, broken cross-tab visibility, races,
  off-by-one errors in keys, ranges or offsets, unhandled errors that leave state inconsistent.
- Data-loss bugs in anything that is supposed to persist across a reload.
- Weakened tests: a deleted, skipped or loosened assertion, a test that no longer exercises the code it
  names, a formal model edited to pass instead of the code being fixed.
- Raised size budgets in `bench/size/rows.ts`.
- Changed scripts (`package.json` scripts, `scripts/`, the bench harness) or lint and dead-code config
  (`.oxlintrc.json`, `.fallowrc.json`) that make a check pass more easily or skip work.
- Benchmarks that read from anything other than the real engine, or that stop checking values.
- Violations of the principles above as stated.

## Nits

Everything else is a `nit`: naming, style, formatting, comments, small duplication, docs wording.
A nit never blocks a merge, so do not dress one up as a blocker.

## Out of scope

Do not ask for features the change does not attempt, for backward compatibility, or for tests of code
the change does not touch.
