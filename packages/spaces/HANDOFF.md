# Handoff: `@opfs-lsm/spaces`

A local-first database on kv: classic Jazz's good parts, without its costs. Work is paused here so the design can be evaluated before sync is built.

- **Design:** [DESIGN.md](DESIGN.md). It is the contract: usage, shape, layout, sync, security, synthesis decision, tradeoffs, open questions.
- **Status:** this file.
- **Nothing is committed.** The package is untracked. `pnpm-lock.yaml` and `.fallowrc.json` are modified.

## How to evaluate

Read in this order. Each step is about 10 minutes.

1. **The API.** DESIGN "Usage" (four call sites) and [tests/usage.typecheck.ts](tests/usage.typecheck.ts), which compiles them against the real types, including the promised type errors.
2. **The five decisions.** DESIGN "Shape". Everything else follows from them.
3. **Security.** DESIGN "Security", then "Tradeoffs accepted" → "No rotation", "Account secret", "Invite links live with the key".
4. **Why this shape.** DESIGN "Synthesis decision": three candidates, the reviewer's pick and why it was overruled, the no-rotation decision, and the design review triage.
5. **What is still open.** DESIGN "Open questions and risks". The decisions waiting on the owner are listed under [Decisions to make](#decisions-to-make).

## Where things stand

| Area | Modules | State | Tests |
|---|---|---|---|
| Local store | `local/*`, `schema.ts`, `ids.ts`, `errors.ts`, `bytes.ts` | Built | 58 |
| Crypto | `space/crypto.ts` | Built | 14 |
| Wire codec | `sync/protocol.ts` | Built | 11 |
| Reference server | `server/*` (memory store, session, hub) | Built | 23 |
| Space registry | `space/spaces.ts` | Sketch (`declare class`) | — |
| Sync engine | `sync/engine.ts`, `sync/transport.ts`, `testing.ts` | Sketch | — |
| App facade | `db.ts` (`openSpaces`), `index.ts` | Sketch | compile-only |
| Files, rich text | `files.ts`, `richtext.ts` (local storage methods exist in `LocalStore`) | Sketch, v1 | — |
| Peer to peer | `sync/peer.ts` | Sketch, deferred | — |

About 5,700 lines of source and 2,500 of tests. 107 tests pass. One harness smoke test is not in the table.

The v0 cut in DESIGN has two steps. Step 1 (local) is done. Step 2 (sync) has its server and codec half done; the device half (registry, engine, facade) is next.

What the built parts already show:
- Typed create/update/delete/get/query/resolve/watch/transact through `LocalStore`.
- Per-field merge across two tabs.
- Stale-schema refusal and cheap schema bumps.
- The cross-space id guard.
- Server-side ACL, compare-and-set and paging.
- Positions that stay short: at most 9 chars after 20,000 appends.

## Decisions taken

**By the owner.**
- **No key rotation.** One key per space for life, server-enforced membership, and E2EE only to hide data from the server. That deleted the signed control log, epochs, key boxes, Ed25519 and X25519, and v0's rotation step.
- **Yjs rich-text field.** A `richText()` field holds a Y.Doc, loaded with a dynamic import.

**By the synthesis** (details in DESIGN "Synthesis decision").
- The `spaces` candidate won over the reviewer's pick (`journal`): a state per record survives power loss and needs no compaction.
- Grafted onto it: fingerprint reconcile for P2P, the server incarnation, and dropping the foreign-record store.

**From the design review** (21 findings, triage in DESIGN). Applied to the sketch and, where the module is built, in code:

| Finding | Fix | Where |
|---|---|---|
| **Critical:** a writer of one space could write into another (ids weren't checked against the space) | Server refuses foreign ids, and the device drops them | server, `LocalStore.applyRemote` |
| A large catch-up page could exceed kv's 8 MiB batch and stall a space forever | Item caps: 256 per commit, 1,024 per page | protocol, server |
| A lost ack could loop pushes forever | Conflicts never skipped. Echo filter only for rich text. Records carry no origin | protocol, engine sketch |
| A lost `join` reply stranded a member without the key | `join`, `create`, `remove`, `leave` are idempotent | server |
| A removed member could rejoin through a link they knew | Removal revokes the invites they created and the one they joined through | server |
| A server that lost its store would make the first reconnecting device admin | `denied` carries the incarnation. Only an admin re-registers. Others wait | protocol, server, engine sketch |
| Data could be pushed under a key with no backup | Push a space only after its `$spaces` record (which holds the key) is acked | registry and engine sketch |
| Wrong key could overwrite good server states | 8-byte key check in `create`, `authOk`, `joined` | crypto, protocol, server |
| Inviting someone to the personal space would hand out every key | Refused by client and server | server, registry sketch |
| Member tokens were permanent | Random token per membership. Only the personal token is derived | crypto, registry sketch |
| `z.date()` silently broke records on other devices | Field outputs must be JSON (compile error), and validators must be idempotent | `schema.ts` |
| A schema bump rebuilt every index and re-downloaded everything | Only new or changed indexes. Re-pull only spaces that skipped a collection | `LocalStore` |
| An ack rewrote the record and re-ran every watcher | Base rev moved to its own key (`73 0B`) | `LocalStore` |
| Live collaboration re-pulled its own items | An ack moves the cursor over the device's own commit | `LocalStore` |
| `between()` grew linearly (4,885 chars after 20k appends) | Variable-length integer head | `ids.ts` |
| Plus several low items | Stamp bound, unset cells kept unset, crash-safe requeue, peer proof direction | `LocalStore`, `peer.ts` |

**Recorded for v1, not built:**
- Rich-text compaction rules.
- File lifecycle: replacing a file cell currently leaks the old blob, ownership is not enforced across devices, and the crash sweep reads chunks.
- A count of unreadable records.
- Re-queuing rich text and files after a server loss.

**Rejected:**
- Collections under `db.c.*`: kept `db.todos`.
- Deriving a created space's key from the account secret.
- Revoking every invite on any removal.

## Deviations from the sketch

These are in the code. DESIGN covers the ones that change behavior.

- **Server:**
  - A record push for an id the server holds nothing for is accepted whatever its base, so a server that lost data takes states back.
  - `subscribe` always answers with a page, possibly empty.
  - `setRole` and `join` on the personal space are refused too, not just `invite`.
  - Every blob refusal (wrong owner, rewritten chunk) is reported as `pushRejected foreign-id`, since the protocol has no blob refusal message. Worth a proper reason when files land.
- **Local store:**
  - A remote cell with an out-of-range stamp is dropped rather than kept as invalid, because it would freeze the field.
  - A collection whose field signature changed gets a full re-encode on a version bump.
  - Adding a default to an existing field does not reindex records the pass does not touch.
  - The flagged-cursor reset has a small race with another tab writing a flag during the reconcile.
- **Not supported yet:** an internal `$spaces` collection in `LocalStore`. The registry needs one, with hand-written validators so there is no runtime zod dependency.

## Decisions to make

These shape what gets built next.

1. **The security model as written.** A removed member keeps the key. Ciphertext they get later, from a breach, a leaked backup or a colluding server, is readable to them. A clean cut means a new space plus a copy. Acceptable for the target apps?
2. **Peer to peer trust.** Peers can only check that the other side holds the key, not its role, so P2P suits one account's devices or a fully trusted group. Is that the P2P story, or does it need server-signed tickets later?
3. **Membership needs the server.** Every change except `create` waits for the server. Fine for small apps?
4. **Invite expiry.** Should invites have one (cheap, server-side)? Today a link lives until revoked, and its wrapped key stays at the server even after use, so retries work.
5. **Device trust.** Data is plaintext at rest on the device, so no crypto runs on local reads and writes. Accept?
6. **Size caps.** 256 KiB per record and 64 MiB per file until kv has a blob store. Accept?
7. **Signed spaces.** Integrity among members is enforced by the server only, with no per-state signatures. Opt-in later, or never?

## If the design is approved: next steps

1. **`LocalStore` internal collection.** Support `$spaces` (catalog id 0), and refuse app collection names starting with `$`.
2. **`SpaceRegistry`.** Space keys and meta, membership requests through the outbox, `settle`, `$spaces` following, and the personal-space rules.
3. **`openSpaces` facade.** Collection APIs over `LocalStore`, `transact`, `spaces`, and sync status.
4. **`SyncEngine` + `testServer` + `websocket`.** Leader election, auth/heal, pull/subscribe, push rounds, and membership requests.
5. **Step 2 integration tests**, as listed in DESIGN "v0 cut":
   - two devices converge;
   - conflict merge and retry;
   - delete never resurrects;
   - restart resumes from the cursor;
   - destroyed kv re-pulls;
   - incarnation heal;
   - the server holds only ciphertext;
   - invite, join and remove;
   - a self-added server gets no key.
6. **v1.** Files and rich text with the recorded lifecycle and compaction rules. A durable `ServerStore`.

## Run it

```sh
pnpm --filter @opfs-lsm/kv build      # spaces imports kv's dist
cd packages/spaces
npx tsc -p tsconfig.test.json         # sketch + implementation type-check, including usage.typecheck.ts
npx vitest run                        # 107 tests
cd ../.. && pnpm static               # lint and docs pass; fallow fails, see below
```

`pnpm static` fails on fallow. Every finding is code whose consumer is still a sketch: `LocalStore` and registry methods the engine will call, key helpers the registry will use, `peer.ts`, files and rich text. They should clear as steps 1–4 land, and anything left then is real dead code. `tests/usage.typecheck.ts` is in fallow's `entry` list, as docstore's usage file is.
