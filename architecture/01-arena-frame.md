# Arena frame — language + high-level architecture

## Artifact

Each candidate produces a design package under its output dir:

- `DESIGN.md` — rationale per architect `rationale-template.md` (Problem, Usage, Shape, Synthesis decision stub, Tradeoffs, Alternatives, Open questions, Next step)
- `SKETCH.md` — language choice with justification; module map; type/signature sketch (`not implemented` bodies); concurrency/ownership diagram in prose; public API surface vs internals

Scope: **programming language** and **high-level architecture** for an LSM KV on async OPFS aimed at eventually replacing Dexie. Not implementation. Not full multi-tab protocol resolution — name owners and stance.

## Rubric

1. **Language fit**: choice matches async OPFS + browser packaging + Dexie-facing DX + path to “way faster”; costs (WASM bridge, GC, tooling) named honestly.
2. **LSM × async OPFS fit**: layout (memtable, WAL, SST, manifest, compaction) exploits immutable file publication and range reads; avoids large mutable single-file updates as the hot path.
3. **Interface depth**: small public surface (KV now, Dexie façade later) that hides engine complexity; no wire/OPFS types on the public API.
4. **Ownership clarity**: one owner per piece of state (memtable, manifest, compaction, tab coordination); concurrency stance explicit (single writer vs multi-writer).
5. **Agent-safe boundaries**: internals not importable as the default path; one way to do each task; no temporal-only layering.
6. **Extensibility to Dexie-shaped API**: indexes / object stores / multi-tab visibility can layer without rewriting the engine core.

## Runners

Architect runners line: `grok-4.7` → Task slug `grok-4.7-high-fast`. Two seats, same model, **mandated structurally distinct directions** (exhaust design space):

| Seat | Direction |
|------|-----------|
| candidate-1 | **TypeScript-native** engine: pure TS/JS on async OPFS; no WASM core. Optimize for Dexie-like DX and SharedWorker-native coordination. |
| candidate-2 | **Rust→WASM core** + thin TypeScript façade: engine (LSM, encoding, compaction) in Rust with an async OPFS adapter; TS owns app API and worker wiring. |

Grounding: `/Users/guidodorsi/workspace/opfs-talk/opfs-async/architecture/00-grounding.md`
Architect runner prompt: pstack architect `references/runner-prompt.md` discipline.
