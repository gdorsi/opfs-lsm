---
name: verify-ingest-visibility
description: "Formally check that ack'd WAL puts stay visible across SharedWorker ingestAll (publishL0 / publishGeneration / advanceIngested). Use when changing ingest.ts, IdBWal.advanceIngested / listUningested, resolveGet, readLayers, or publishGeneration / publishL0 — or when a get might miss after a successful put."
---

# Verify ingest visibility (NoLostAcks)

## Property

**Property:** After `put`/`batch` commits to the shared IDB WAL, `get` must still see that value until a later write supersedes it — including while `ingestAll` moves the row from WAL into OPFS.

**Harm if broken:** The client observed a successful commit, then a later `get` returns missing because `advanceIngested` removed the WAL row before `publishGeneration` made the SST readable.

## When to run

Run this check when a change touches any of:

| File | Symbols |
|---|---|
| `packages/kv/src/host/ingest.ts` | `ingestAll` |
| `packages/kv/src/idb/wal.ts` | `listUningested`, `advanceIngested`, `listRange` |
| `packages/kv/src/store/overlay.ts` | `resolveGet` |
| `packages/kv/src/store/generation.ts` | `publishL0`, `publishGeneration`, `loadLatestGeneration` |
| `packages/kv/src/db.ts` | `readLayers`, `get` |

If the change is intentional (new ingest step order, new visibility rule), update the model under `packages/kv/formal/ingest-visibility/` so it still mirrors the code, re-run the check, then move the sync commit below forward.

## Tool and why

Exhaustive BFS over a small TypeScript model of the same atomic steps (`append`, `beginIngest`/`listUningested`, then the three awaits in `ingestAll`). Chosen instead of TLA+/TLC so the check runs with the repo’s existing `tsx`/`pnpm` toolchain (no JVM). The model’s ingest step **order is parsed from** `ingest.ts`, so reordering those awaits changes the explored system.

## Bounds and assumptions

- One key (`k`); at most **2** appends.
- At most one in-flight ingest; appends may interleave between ingest awaits (as real `await`s allow).
- `publishL0` alone does not make data visible to `resolveGet`; only `publishGeneration` updates SST (matches `loadLatestGeneration` + `readLayers`).
- Omits: multi-key batches, compaction (`maybeCompact`), Bloom/SST layout, SharedWorker ports, OCC/transactions, multi-tab caches, crashes mid-await.

A pass means: within those bounds, every interleaving of the model preserves NoLostAcks. It does not prove the whole KV correct.

## Command

From the repo root (or `packages/kv`):

```sh
pnpm --filter @opfs-lsm/kv formal:ingest-visibility
```

Exit `0` = pass. Exit `1` = violation; stdout/stderr prints the shortest path in code words (`append`, `beginIngest(listUningested)`, `publishL0`, `publishGeneration`, `advanceIngested`).

## Reading a failure

A real bug looks like: `advanceIngested` appears **before** `publishGeneration` on the path, and `resolveGet` is undefined while an ack exists. That matches deleting/hiding WAL rows before the generation file points at the new L0.

A modeling error looks like: the path cannot happen in the TypeScript (e.g. the parser invents a step order that is not in `ingestAll`), or the model treats `publishL0` as visible when `readLayers` does not. Fix the model or parser; do not weaken NoLostAcks.

## Coverage record

| Model piece | Code |
|---|---|
| `append` | `Db.batch` / `IdBWal` append (ack) |
| `beginIngest` | `wal.listUningested()` at start of `ingestAll` |
| `publishL0` | `publishL0(...)` in `ingestAll` |
| `publishGeneration` | `publishGeneration(...)` in `ingestAll` |
| `advanceIngested` | `wal.advanceIngested(last)` in `ingestAll` |
| `resolveGet` / NoLostAcks | `resolveGet` + `Db.readLayers` (WAL over SST) |

**Sync commit:** `af794f790f1a631460a7c989be54080f3575b153` — last commit at which this verification was confirmed to describe the code above. Move this forward only after re-running the command and confirming the model still matches those symbols.

## Updating after an intentional change

1. Edit product code.
2. Adjust `packages/kv/formal/ingest-visibility/model.ts` (and parser if new awaits) so steps still match indivisible awaits/commits.
3. Run `pnpm --filter @opfs-lsm/kv formal:ingest-visibility`.
4. On pass, set **Sync commit** to `git rev-parse HEAD`.

For drift after merges that skipped this skill, use `/maintain-formal-verification-skill`.
