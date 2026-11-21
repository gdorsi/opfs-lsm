# @opfs-lsm/spaces

A local-first database on `@opfs-lsm/kv`. Records live in **spaces**. A space is the one unit of sharing, encryption, membership and sync. The server stores ciphertext it cannot read and merges nothing.

## Problem

The owner wants classic Jazz's good parts on kv: zod schemas, typed queries, offline-first sync that could go peer to peer, and a server that cannot read the data. The grounding names what made Jazz slow and buggy.

- Every transaction paid for a signature, a hash, a cipher and JSON, across a wasm boundary.
- Permissions were replayed for each transaction as of its `madeAt`, after the group and its parents loaded.
- Logs were never compacted, and nothing could be deleted.
- CoList and CoPlainText kept one op per element. CoFeed kept one stream per session.
- Files were base64 transactions inside a log.
- Key rotation was a concurrent CRDT write by any admin. It recursed through parent and child groups without a transaction and could skip a reveal with only a warning.

kv adds hard constraints:

- An `update` body is synchronous, so WebCrypto cannot run inside it.
- kv seq is not a durable cursor.
- Change events carry no origin.
- A batch is at most 8 MiB, counting 256 B per op.
- `valueContains` and every index read plaintext bytes.
- kv runs only in the browser. Tests use a Node harness.
- Deletion needs a replicated tombstone that outlives the data.
- Consistency is guaranteed and persistence is not. After a power loss a client can fall behind what the server holds.

Two things make the shape non-obvious.

1. A zero-knowledge server cannot merge. Whatever it stores must be either append-only, which is Jazz's unbounded log, or replaced under a rule it can check without reading.
2. Something must enforce membership, and the server that enforces it must still be unable to read the data or give itself a key.

## Usage (caller's view)

### Quickstart

```ts
import { z } from "zod";
import { openDb } from "@opfs-lsm/kv";
import {
  between,
  collection,
  defineSchema,
  file,
  openSpaces,
  ref,
  richText,
  websocket,
} from "@opfs-lsm/spaces";

// A field is any Standard Schema validator (zod, zod/mini, valibot),
// or ref / file / richText.
const List = collection("lists", { title: z.string().min(1) });

const Todo = collection(
  "todos",
  {
    list: ref("lists"),
    title: z.string().min(1),
    done: z.boolean().default(false),
    position: z.string(), // fractional index from between()
  },
  { indexes: { byList: ["list", "position"] } },
);

const Chat = collection("chats", { title: z.string() });
const Message = collection(
  "messages",
  {
    chat: ref("chats"),
    text: z.string().max(4000),
    image: file().optional(),
    sentAt: z.number(),
  },
  { indexes: { byChat: ["chat", "sentAt"] } },
);

const Note = collection("notes", {
  title: z.string(),
  body: richText(),
});

export const schema = defineSchema({
  version: 1,
  collections: [List, Todo, Chat, Message, Note],
});

export const db = await openSpaces(schema, {
  kv: await openDb({ name: "my-app" }),
  server: websocket("wss://sync.example.com"), // optional: the app works without it
});
```

Every record lives in a space. Without `{ space }`, the record goes to the account's personal space, which syncs to the user's other devices and no one else.

```ts
const mine = await db.todos.create({
  list: inbox.id,
  title: "Call mom",
  position: between(),
});
db.spaces.of(mine.id) === db.spaces.personal; // => true
```

### Call site 1: a shared todo list

```ts
// Creating a space works offline. The leader registers it with the
// server on the next connection.
const space = await db.spaces.create();
const list = await db.lists.create({ title: "Groceries" }, { space });
await db.todos.create(
  { list: list.id, title: "Milk", position: between() },
  { space },
);

// Share: the link carries the space id and an invite secret in the
// fragment, so the server never sees it. Needs the server once.
const link = await space.invite("writer");
// "https://my-app.example/#join=…"

// On the friend's device:
const joined = await db.spaces.join(link); // needs the server once

// Render. The listener gets the whole result, in index order, after
// every local, other-tab or remote change to `todos`.
const stop = db.todos.watch(
  { index: "byList", eq: [list.id] },
  (todos) => renderList(todos),
);

// Reorder: no list CRDT, just a new position. Concurrent moves of the
// same item keep one of the moves, and the item never duplicates.
await db.todos.update(todo.id, {
  position: between(prev?.position, next?.position),
});
await db.todos.update(todo.id, { done: true }); // per-field merge
await db.todos.delete(todo.id); // terminal: no peer can bring it back

// Clear the done items atomically, in one kv transaction.
const done = await db.todos.query({
  index: "byList",
  eq: [list.id],
  filter: (t) => t.done,
});
await db.transact((tx) => {
  for (const t of done.rows) tx.todos.delete(t.id);
});

// Remove a member. The server stops serving them at once. They keep
// the key and what they already synced.
const { members } = await space.members();
const other = members.find((m) => !m.me);
if (other) await space.remove(other.id);
```

### Call site 2: a chat with an image attachment

```ts
async function send(chatId: RecordId<"chats">, text: string, picked?: File) {
  const space = db.spaces.of(chatId)!;
  // Encrypts the file in 1 MiB chunks into kv, right away and offline.
  // The bytes upload before the message that references them syncs.
  const image = picked && (await db.files.put(picked, { space }));
  await db.messages.create(
    { chat: chatId, text, image, sentAt: Date.now() },
    { space },
  );
}

// The latest 50 messages, newest first, each with its chat resolved
// from the same snapshot.
const page = await db.messages.query({
  index: "byChat",
  eq: [chatId],
  reverse: true,
  limit: 50,
  resolve: { chat: true },
});
page.rows[0]?.chat?.title; // Row<typeof Chat> | undefined

for (const m of page.rows) {
  if (m.image) {
    // Local chunks if present. Otherwise fetched from the server,
    // stored, then decrypted.
    img.src = URL.createObjectURL(await db.files.read(m.image));
  }
}
```

### Call site 3: a rich-text note

```ts
import { ySyncPlugin } from "y-prosemirror";

const note = await db.notes.create({ title: "Plan" }, { space });

// A lease on the field's Y.Doc. The first open loads it from kv. Later
// opens share it. Edits from other tabs and other devices arrive live.
const body = await db.notes.open(note.id, "body");
const view = new EditorView(el, {
  state: EditorState.create({
    schema: pmSchema,
    plugins: [ySyncPlugin(body.doc.getXmlFragment("doc"))],
  }),
});

// on unmount
view.destroy();
body.release(); // the doc stays loaded 5 s for a quick remount

await db.notes.delete(note.id);
// The body's updates are gone locally and on the server, and every open
// lease reports `deleted`.
```

### Call site 4: typed reads

```ts
const todo = await db.todos.get(id, { resolve: { list: true } });
//    ^? { id: RecordId<"todos">; list: Row<typeof List> | undefined;
//         title: string; done: boolean; position: string } | undefined

await db.todos.query({ index: "byList", gt: "x" });
// type error: `list` comes first in byList, so a bound needs `eq: [listId]`
await db.todos.create({ title: "x" });
// type error: `list` and `position` are required
await db.todos.update(todo!.id, { done: "yes" });
// type error. At runtime the field validator throws SpacesError "validation".
```

## Shape

Five load-bearing decisions. The rest follows from them.

1. **The space is the only container.** A space is the one unit of sharing, encryption, membership and sync. Spaces do not nest. A record belongs to exactly one space, and its id starts with the space's tag, so it can never move.
2. **A record is a map of per-field last-write-wins cells.** Each cell is stamped by a per-tab hybrid logical clock. There is no sequence CRDT and no feed type. Rich text is a Yjs field next to the cells.
3. **Plaintext at rest locally, ciphertext on the wire and at the server.** Crypto never runs on a local read or write.
4. **The server keeps one sealed state per record and replaces it by compare-and-set.** The client names the server rev its state includes. The cursor is a per-space server rev, stored in the same kv batch as the data it covers.
5. **Membership is a server ACL over bearer tokens, and a space has one key for life.** Encryption hides data from the server and nothing more. The server enforces roles. A key reaches a device only through an invite link or the account's own personal space, so the server cannot hand itself one. There is no rotation.

### Module map

Each module owns one body of knowledge. A local write passes through three files: `db.ts` validates, `local/store.ts` writes, `local/merge.ts` merges. A remote change also passes through three: `sync/engine.ts` opens and validates, `local/store.ts` writes, `local/merge.ts` merges.

| Module | Owns | Est. lines |
|---|---|---|
| `index.ts` | public surface. `exports` lists only `.`, `./testing` and `./server` | 40 |
| `db.ts` | `openSpaces`, typed collection facades, `transact`, validation of app input | 260 |
| `schema.ts` | field kinds, `collection`, `defineSchema`, the type machinery for rows, queries and resolve | 280 |
| `ids.ts` | ids with the space tag inside, `between()` | 140 |
| `local/keys.ts` | the kv key layout, nowhere else | 130 |
| `local/record.ts` | cells, stamps, `Clock`, the record value codec (disk = wire) | 220 |
| `local/merge.ts` | pure merge rules, index derivation | 170 |
| `local/tuple.ts` | docstore's tuple codec, until it moves to kv | 120 |
| `local/store.ts` | `LocalStore`, the only writer of record-scoped and file-scoped keys: write, applyRemote, acknowledge, read, query, watch, catalog, rebuild, rich-text and file key access | 560 |
| `space/crypto.ts` | every crypto format, on WebCrypto | 170 |
| `space/spaces.ts` | `SpaceRegistry`: the Space API, space keys, membership requests, the `$spaces` list | 300 |
| `sync/protocol.ts` | wire messages and binary codec (shared with the server) | 330 |
| `sync/engine.ts` | `SyncEngine`: leader election, pull, push, open and validate | 520 |
| `sync/transport.ts` | `websocket()` | 50 |
| `files.ts` | `FileStore` | 260 |
| `richtext.ts` | rich-text leases, loaded with a dynamic import | 240 |
| `sync/peer.ts` | peer-to-peer sync (deferred) | 300 |
| `testing.ts` | in-process server and transport | 120 |
| `server/*` | `createSpacesServer`, `ServerSession`, `ServerStore` with `MemoryServerStore` | 520 |

### Data model

| Kind | Declared as | Stored as | Merge |
|---|---|---|---|
| Value | any Standard Schema validator (zod) | a cell | last write wins per top-level field, by stamp |
| Ref | `ref("lists")` | a cell holding the target's id | last write wins |
| File | `file()` | a cell holding a `FileRef` (id, name, type, size, file key) | last write wins. The blob is immutable |
| Rich text | `richText()` | Yjs updates under the record (`73 05`) | Yjs |
| Record | `collection(...)` | one kv value | per field. Delete is terminal |

**Stamps.** A stamp is 48 bits of wall-clock ms, a 16-bit counter and a 32-bit random tab session: 12 bytes, written as 16 order-preserving chars. The session only breaks ties, so tabs never coordinate clocks. A stamp is issued inside the `kv.update` body as `max(now, largest stamp among the cells it overwrites) + 1`. A local write therefore always beats the value its writer saw, whatever the clocks say. The clock needs no persistence (`local/record.ts` `Clock`). Stamps past the year 3000 are out of range: the clock never issues one, and a remote cell carrying one is dropped, since it would win every merge and freeze the field. A fixed bound is safe for convergence; a moving clamp would not be.

**Deletion is terminal.** A tombstone wins over every cell of any stamp, and ids are random, so "undelete" is a new record. Tombstones are kept forever: about 40 bytes locally and 90 at the server.

**Validation is per field because merging is per field.** A collection's shape is a record of validators, not one object schema. A rule that spans two fields cannot hold after merging two valid writes, so the schema cannot express one. Validators run once at the edge: app input in `db.ts`, and remote input in `sync/engine.ts`. Reads never validate.

**Validators must output JSON and be idempotent.** A local write stores the validator's output, and every other device validates that output again. The output must therefore be valid input that maps to itself, and its type must be JSON: `z.date()` is a compile error, and a date is `z.iso.datetime()` or a number. On the remote path the wire value is stored as it is once it validates.

**Schema skew between app versions.**

- A cell this app version cannot validate is kept with `valid: false`. It sits in the record's meta and round-trips on push. Reads never see it.
- A record whose required field holds no valid value is stored with `readable = 0`. Reads and indexes skip it, and `status()` reports `"unreadable"`.
- A record of a collection this app version does not declare is skipped on pull.
- A pull that skips such a record flags the space's cursor. When a later version declares a new collection, only flagged cursors are reset, so only those spaces pull again.
- A version bump builds only new or redefined indexes. It re-encodes the records of a collection whose field signature (kind, required, default) changed, and otherwise re-validates only records that hold an invalid cell (a flag in the record value). Validators may loosen across versions; tightening one needs a migration. New defaults go into the fields slice in the same pass, so reads never fill defaults. An unset cell stays unset.

**Ordered lists replace CoList.** A list is a collection with a `position` string from `between(before, after)`, a fractional index with a variable-length integer head and a random suffix, and an index ending in that field. After n appends or prepends a position is at most 6 + log62(n) chars, suffix included.

- Inserts never conflict.
- Two concurrent inserts at one spot get distinct positions.
- A concurrent move of one item keeps one of the moves, and an item never duplicates.

**Feeds replace CoFeed.** A feed is a collection of insert-only records with an index on a time field. Each message is its own record, so nothing needs a sequence CRDT. Who sent it is an ordinary field and is not proven cryptographically (see "Tradeoffs").

**Unique records.** `keyedRecordId(space, collection, key)` gives the same id on every device. Two devices that create it offline merge field by field into one record, which covers Jazz's `upsertUnique`.

**Index queries span spaces.** Index entries of all spaces interleave, and only a plain scan takes `space`. To query one space through an index, lead the index with a ref to a record of that space (`byList`), which implies the space.

### Local layout in kv

All keys start with `0x73`. The layout is in `local/keys.ts` and nowhere else.

```
73 00 <name>                       meta: account secret, catalog
73 01 <coll u8> <record 16>        live record (RecordValue)
73 02 <record 16>                  tombstone, kept forever
73 03 <coll> <index> <tuple> 00 <rec>   index entry
73 04 <kind> …                     outbox: record, rich-text update, membership request, file upload, file want
73 05 <rec> <field u32> <origin u32> <seq u32>   rich-text update
73 06 <space 16>                   space key and member token
73 07 <space 16>                   pull cursor (server incarnation, ServerRev, flags)
73 08 <space 16>                   space meta: this account's standing
73 09 <file 16>                    file manifest
73 0A <file 16> <chunk u32>        file chunk, sealed as on the server
73 0B <record 16>                  base rev: its own key, so an ack never rewrites the record or wakes a watch
```

A record id starts with its space tag, so the records of one space in one collection are one prefix. A tombstone has its own prefix, so record scans never step over dead rows. A record's rich text and files sit under one prefix each, so deleting them is one `deleteRange` each.

The record value is `flags | metaLen | meta JSON | fields JSON`. A read parses only the fields slice, which holds only valid values plus materialized defaults. The wire plaintext is the value from `metaLen` on, byte for byte, so a push seals the stored bytes without re-encoding them.

### Writes, reads, queries

- **Write.** `create`, `update`, `delete` and `transact` share one path.
  1. Validate each field, outside kv.
  2. Run one `kv.update`, which reads the catalog key, the record and tombstone keys, and the manifests of referenced files.
  3. Inside the body: stamp, merge, diff the index entries, put the outbox entry, and throw `stale-schema` if another tab upgraded the catalog.

  No retry loop is needed, because the merge runs inside the body and nothing planned outside it can go stale. Ops on several records, collections and spaces land together or not at all.
- **Read.** One kv point read and one `JSON.parse` of the fields slice.
- **Query.** One kv `view`:
  1. An index range, then one batch of `snap.get`s for its rows in the same view, or a plain range over the record prefix of a collection or of one space.
  2. The rows, decoded from their fields slice.
  3. The JS `filter`.
  4. One batch of `snap.get`s per `resolve` level.

  The query types are docstore's: `eq` fixes the leading fields, and one bound applies to the next field.
- **Watch.** A `kv.changes` listener on `73 01 <coll>` reruns the query once per microtask. It covers this tab, other tabs and remote applies alike, and a `gap` reruns it too.

### Sync: client and server

**Tabs.** One tab per device runs sync. It holds the Web Lock `opfs-lsm-spaces:<kv name>:sync` and the only connection. The other tabs share kv: they see what it applies through `kv.changes`, and it sees their writes through the outbox prefix. kv is the only channel between tabs.

**What the server stores, per space.**

- The ACL: member ids with roles, and invites with their wrapped keys.
- One sealed state per live record, or a sealed tombstone.
- Sealed rich-text updates per field, until a client compacts them.
- Sealed file chunks, until the owning record is tombstoned.
- A counter, the ServerRev, bumped once per accepted commit.

The server keeps no history and no per-device logs. Its storage is proportional to live data plus tombstones.

**The cursor.** The cursor is the highest ServerRev applied, per space, at `73 07`. It is written in the same kv batch as the page it covers, and an ack moves it over the device's own commit when it stood just below it, so live collaboration never re-pulls its own items. `pull{after}` returns the live items with a greater rev, in rev order, and never splits a commit across pages. A commit is at most 256 items and a page at most 1,024 items or one commit, so an applied page stays under kv's 8 MiB batch. A superseded state is never sent, so a device that was away pulls each changed record once instead of replaying its history. The server's counter is durable, and kv seq appears nowhere. Once caught up, the device subscribes, and the server sends one page per later commit. A page that does not start at the cursor makes the device pull again.

**A server that lost data.** Each server store has a random incarnation, sent with the space's head on `authOk` and on `denied`. A store must commit durably and draw a new incarnation on any restore. A cursor of another incarnation, or above the head, means the server was restored or replaced. The device re-queues every record of the space and pulls from 0, writing the new cursor only after the last record is queued, so a crash re-runs the heal. State is the unit, so pushing it all again is idempotent. A record the server holds nothing for is accepted whatever its base. Rich-text updates and file uploads are not re-queued yet (v1).

If the server lost the space itself, `denied` comes with another incarnation, and nobody is treated as removed. A device whose standing is admin registers the space again with the same key check and re-adds the members it cached from the last member list. The others wait. Members the cache missed need a new invite.

**Push is a compare-and-set.** The server's rule in `server/session.ts`, for a push to record r:

- **Record.** A record item carries `base`, the ServerRev its state includes. If `base` equals the record's current rev, the server stores the item at `rev = head + 1`. Otherwise it returns its current item as a conflict. The device merges the conflict locally, the record stays in the outbox with the new base, and the next round pushes it again. A record has one version at the server, and the server never needs to merge.
- **Tombstone.** Never refused. It drops the record's rich text and blobs. Any later item for that id comes back as a conflict holding the tombstone, which deletes the record on the device that sent it. Conflicts are the one path for "the server knows better".
- **Rich-text update.** Appended, because Yjs updates commute. A `richTextState` replaces the updates it covers.
- **Roles.** Only writers and admins may push. A reader's push is refused whole.
- **Ids.** Every item id must carry the space's tag. The server refuses a push with a foreign id, and a device drops any item whose id names another space, so a writer of one space cannot reach the records of another.
- **Key check.** `authOk` and `joined` carry an 8-byte check of the space key. A device whose key does not match stops before pushing, instead of overwriting good states with bytes nobody can open.
- **Key backup first.** A space's records are pushed only after the `$spaces` record that holds its key is acked, so no ciphertext reaches the server under a key that lives on one device.

**Power loss.** kv keeps a consistent prefix, and the design relies on that.

- The cursor and the data it covers fall back together, so the device pulls that suffix again and merges it idempotently.
- A write that was pushed before the loss comes back on that pull. The engine's ClientId is new after a restart, so it does not skip its old items.
- A lost `acknowledge` leaves an old base. The next push conflicts with the device's own state, merges to no change, and clears.
- A write that was never pushed is lost. That is the persistence kv does not promise.

**Echo.** Records need no echo filter: a device's own state coming back merges to identical cells and only raises the base. Conflicts are never skipped. A record conflict that does not open raises the base, so the device's state replaces it; a tombstone conflict that does not open is parked and reported, since applying it would let a server delete records. Rich-text items carry the pushing engine's ClientId, and the engine skips its own, which would otherwise be stored twice.

**Concurrent writers.** Two tabs, or a tab and the sync leader, are serialized by `kv.update`. Two devices are serialized by the server's per-record compare-and-set. Each side merges what it read.

**Atomicity across records is local.** A `transact` lands atomically in kv. At the server, the accepted records of one push share one commit, so a subscriber applies them in one batch. A record that conflicts goes out in the next commit, and a long catch-up can split a commit's effects across pages. Replicas converge, and may briefly show part of a multi-record write.

### Sync: peer to peer (deferred, `sync/peer.ts`)

Peers can merge, so they need no compare-and-set and no cursor. They reconcile state.

- **Reconcile.** Each side scans the space's records and tombstones and folds them into 256 bucket fingerprints, each the sum of H64(record id || digest of its (field, stamp) pairs). Differing buckets exchange (id, digest) lists, then each side sends the states the other lacks or holds differently. Merges are idempotent, so over-sending writes nothing. A peer that lost writes to a power loss just differs in a bucket: there is no log position to reuse and no cursor to fall behind. After reconciling, each side forwards what it applies, and an item that merges to no change is not forwarded again.
- **Trust.** Peers prove they hold the space key with an HMAC over both nonces and a direction byte. Roles live at the server, so a peer cannot check them: anyone who ever held the key, including a reader or a removed member, is a full peer. P2P therefore suits one account's devices, or a group that trusts every key holder.
- **Forwarding.** A state that came from a peer and differs from the server base stays in the outbox. The device pushes it like its own write, and the server's compare-and-set drops duplicates.
- **Membership.** Membership changes need the server. With no server reachable, data syncs and membership waits.

### Deletion without resurrection

These rules hold in this order and depend on none of the timing between them.

1. **Terminal merge.** A tombstoned id drops every later cell, rich-text update and file chunk, locally and at the server.
2. **One transaction.** A local delete runs in one `kv.update`. It puts the tombstone, deletes the row, its index entries, its rich-text updates and their outbox entries, and its file chunks, and queues the tombstone for push.
3. **Checked rich-text writes.** Every rich-text write is a `kv.update` that reads the tombstone key first. No write can land after the delete, whatever order the awaits run in.
4. **Leases detach at once.** Open leases see the delete in `kv.changes` and detach their update handlers synchronously, before any await.
5. **No seeding.** `open()` refuses a missing or deleted record, so a field document is never created for an id that no record lists.
6. **Server tombstones.** At the server, a tombstone is a terminal item kept forever, and it frees the record's rich text and blobs. A device that later pushes anything for that id gets the tombstone back as a conflict and applies it.
7. **Keyed ids.** A local write reads the tombstone key, so re-creating a deleted `keyedRecordId` throws `deleted` instead of writing a live row beside the tombstone.

### Security

**Goal.** Encryption hides data from the server, and that is all it does. The server enforces who may read, write and administer a space. Members trust each other with the data.

**Keys.**

- **Account.** One 32-byte secret, stored in kv and shared by the user's devices through `exportSecret`.
- **Space key.** One random AES-256-GCM key per space, for the space's whole life. There are no epochs and no rotation.
- **Member token.** 32 random bytes per membership, stored with the space key, so every device of an account is one member. A re-join gets a new token. The server stores only the token's id, the first 16 bytes of its SHA-256, and ids are unlinkable across spaces. A token is a bearer secret worth write access: it never leaves TLS, and the transport refuses `ws://` outside localhost.
- **Personal space.** Its id, key and token are derived from the account secret, so a newly linked device recomputes them. It holds a `$spaces` record `{ space, key, token }` per joined space, so the account's other devices get every membership. Leaving marks the record instead of deleting it. It has no other members: the client and the server refuse invites to it, which would hand out every key.
- **Key check.** 8 bytes, `HKDF(space key, "spaces/key-check")`, registered at `create`. It detects a wrong key before a push, and reveals nothing usable about the key.
- **Item binding.** Items are sealed with an AAD that binds kind, space, record and field, so the server cannot move a ciphertext into another slot.
- **Nonces.** One key per space for its life, with random 96-bit nonces, stays far below the AES-GCM bound: 2^32 seals is years of constant typing in one space.
- **No dependency.** All formats are in `space/crypto.ts`, on WebCrypto: AES-GCM, HKDF and SHA-256. No signatures and no key agreement.

**Membership** is an ACL at the server: member id to role (`admin`, `writer`, `reader`), plus live invites. Each change is a request the server applies under the space's lock (`sync/protocol.ts`). The last admin cannot be removed, demoted or leave.

- **Create.** A new space is usable offline at once. The sync leader registers it with `create` on the next connection. The server refuses an id that exists.
- **Invite.** A link is `#join=<space id>.<secret>`. The secret stays in the fragment, so the server never sees it, and `join` strips it from the address bar. HKDF derives an invite token and a wrap key from it. The admin registers the invite's id, role and use count, and the space key sealed under the wrap key.
- **Join.** The joiner presents the invite token and its member token. The server adds the member and returns the wrapped key and key check, which only a holder of the link can use. A "once" invite is then bound to that member. A retry after a lost reply returns the same answer, so a join never strands a member without the key.
- **Who gets a key.** A key reaches a device only through an invite link or the account's personal space. No client ever seals the key for a member the server names, so a server that adds itself to its own ACL can sync ciphertext but cannot open it.

**Removal.** `remove` takes effect at the server at once. The member's token fails `auth`, live sessions get `denied removed` and are dropped, and later pushes are refused. The invites the member created and the one it joined through are revoked in the same step, so a link it knows cannot bring it back.

**What removal does not do.**

- The member keeps the space key, everything they synced, and the file keys inside records they could read.
- The key never changes. A removed member who later obtains ciphertext, from a server breach, a leaked backup or a server that colludes with them, can read the whole space, including data written after the removal.
- A removed member's unpushed offline edits are refused.
- Among members, write permission is enforced by the server, because the key is symmetric. A server colluding with a reader could inject validly sealed data. Confidentiality still holds against the server alone, which has no key.

**What the zero-knowledge server learns.**

| It sees | It does not see |
|---|---|
| Space ids, and when each was created | Collection names, field names, values |
| The ACL in clear: per-space member ids, roles, invite ids with role and use count, who created each invite and who joined through it, and when each changed. Wrapped keys stay opaque | Refs between records |
| Per item: kind, random record id, rich-text field hash (FNV-1a, so a dictionary can guess a name like "body"), size, rev, arrival time, which member pushed it | Which member wrote which field (it sees only who pushed a state) |
| Which records were deleted, and when | File names, types, contents |
| Per file: id, owner record id, chunk count, size, who uploaded or fetched it | Space display names (they are records) |
| Connection metadata: IP, timing, and which spaces one connection authenticates (that links one device's spaces, and the personal space id is a stable pseudonym for the account) | Any account identity: there are no accounts at the server |

**What a malicious or breached server can do.**

- Alone, it cannot read or forge content.
- With any current or former member, or with anyone who held an invite link whose wrapped key it kept, it can read the whole space, including later data.
- It can withhold or drop anything, serve an old state of a record to a new device, hide tombstones from new devices, fake the member list, and let a reader or removed member write.
- A passive dump yields ciphertext, the ACL and the wrapped keys of live invites. Token ids cannot authenticate.

### Files

`db.files.put(blob, { space })` reads 1 MiB slices and seals each one with a fresh per-file key (AES-GCM, counter nonce, and a `last` flag in the AAD against truncation). It writes them to `73 0A` in kv batches of at most 6 chunks. The manifest goes in the batch with the last chunks, so a manifest is never present without its chunks. It works offline.

**Ownership.** The first record that stores the `FileRef` becomes the file's owner, in the same `kv.update` as the record write. A second owner throws `file-attached`. A blob therefore dies with exactly one record, and the server can free it without reading anything.

**Upload and download.**

- **Upload.** The sync leader sends the stored ciphertext as it is, before the record that references it, so no device ever sees a reference whose bytes are not on the server.
- **Lazy fetch.** A tab that reads missing chunks writes a want entry. The leader fetches the chunks over its connection and stores them. The reading tab wakes on `kv.changes`. No tab needs its own connection.
- **Streaming.** `stream()` yields chunks as they arrive.

**Lifecycle rules (v1, from the design review).** The server refuses a `blobPut` whose owner differs from the stored one or whose chunk already holds other bytes. Still to build with `files.ts`:

- Replacing a file cell deletes the old file's chunks and manifest in the same batch, and the push item names it so the server frees it. Stamps only grow, so the old ref never wins again.
- A manifest created by a download takes its owner from the record that carries the ref.
- The manifest is written first with `complete: false`, so the crash sweep reads manifests, not chunks.
- The engine skips a record whose file still has an upload entry in the same snapshot it read the record from.

**Limits.** A chunk is 1 MiB and at most 6 go in one batch, against kv's 8 MiB. A file is at most 64 MiB until kv has a blob store, because chunks inside the LSM are rewritten by compaction.

### Rich-text field

`richText()` declares a Yjs document attached to the record. `db.notes.open(id, "body")` returns a ref-counted lease on its `Y.Doc`, and `y-prosemirror` or `y-lexical` bind to `lease.doc`. Yjs is loaded with a dynamic import on the first `open`.

- **Persistence.** One key per update at `73 05 <record> <field hash> <origin> <seq>`, as in `@opfs-lsm/yjs` `KvPersistence`. Loading is one range scan in one `Y.transact`. Once 500 updates are stored, all of them pushed, and 1 s has passed without an edit, they are trimmed into one state with `deleteRange({ through: snap.seq })`.
- **Live edits.** The lease follows `kv.changes`. Updates under its prefix from another origin are applied with origin `REMOTE`, which covers both other tabs and the leader's pulls. Each update is stored once per device, not once per tab as with `broadcastSync`.
- **Sync.** Local updates queue in the outbox. Each push round merges a field's pending updates into one, seals it under the space key, and appends it. After a trim, any member may push a `richTextState` that covers its cursor, and the server drops what it covers.
- **Encryption.** On the wire only, with the field hash in the AAD. Local trims merge plaintext, with no crypto.
- **Deletion.** As in "Deletion without resurrection": tombstone-checked writes, synchronous detach, and no seeding.
- **Compaction rules (v1, from the design review).** The engine builds a `richTextState` itself in one `kv.view`: it reads the cursor and every row of the field in the same snapshot, requires the field's outbox to be empty in it, and sends `covers` equal to that cursor. A row count per field triggers it. A field that ever skipped an item is never compacted. The local trim also folds unpushed updates into one pending row, so a device offline or without a server stays bounded. One push holds at most one rich-text item per field.

### Hot paths

| Path | kv | Crypto | Decode and other |
|---|---|---|---|
| `get(id)` | 1 point read (memtable or SST pages, never IndexedDB) | none | 1 `TextDecoder` + `JSON.parse` of the fields slice |
| `query`, n rows, k resolved | 1 `view`: 1 range of n entries + n + k gets | none | n + k field parses. `filter` in JS |
| `create` / `update` / `delete` | 1 `kv.update` (one IndexedDB transaction). Reads catalog + record + tombstone (+ file manifests). Writes record + index diff + outbox, 3 to 6 ops | none | per-field validator calls, decode and encode of one record |
| `transact`, n records | 1 `kv.update` for all n | none | n × the above |
| Open, cold | `openDb` + 1 `update` (catalog) + 1 get (account) + 2 small ranges (space keys, space meta) | 1 HKDF (personal space) | No record is read |
| Remote page, n records | 1 `kv.update`: reads catalog, cursor, n × (record, tombstone, base, outbox). Writes changed records + entries + bases + cursor | n AES-GCM opens, in parallel | n × JSON.parse of meta + fields. Validators only for incoming cells |
| Push, n records | 1 `rangeJoin` (outbox to records) + n base gets in one view + 1 `kv.update` (acks: bases, outbox, cursor) | n AES-GCM seals | none: stored bytes are the plaintext |
| Keystroke in rich text | 1 `kv.update` (tombstone check + update + outbox entry) | none | Yjs encode |
| Remote rich-text update | 1 item in a page, then `applyUpdate` in each tab with the doc open | 1 open | none |
| `files.put`, s MiB | ⌈s/6⌉ batches | s chunk seals | `Blob.slice` |

Jazz's per-op work is gone from every path:

- **Gone entirely:** signatures and hash chains on data, permission replay, dependency loading, and per-character ops.
- **Moved off the local paths:** crypto runs only when bytes leave or enter the device, once per record state, not once per field or keystroke.

Nothing is signed. `auth` is one bearer token per space per connection, and membership requests are rare.

### Interface depth

The public surface is small:

- `openSpaces`, and the five schema helpers.
- `between` and `keyedRecordId`.
- Eight methods per collection.
- `transact`.
- `spaces`: five methods, plus the `Space` methods.
- `files`: four methods.
- `sync`: a status object.

Behind it sit the key layout, the stamps and merge, index maintenance and the catalog upgrade, the outbox and cursors, every crypto format, membership requests and invites, the compare-and-set, paging, leader election, the tab bus, chunking, Yjs persistence and trim, and the deletion protocol.

A caller never handles a stamp, rev, key, token, envelope or session. Wire types never cross the public surface (per boundary-discipline). The server's storage interface is the one place they appear, because a storage implementer needs them.

### Type honesty

The sketch type-checks under `strict` and `noUncheckedIndexedAccess`, with no `any`. `tests/usage.typecheck.ts` compiles the Usage section against it, including every promised type error. One cast remains, and it is deliberate. `LocalStore` is untyped: rows are `{ id: string }` plus JSON. `db.ts` asserts them to `Row<C>` in one place, the facade. The fields slice only ever holds values the same validators accepted, or their defaults, so the assertion is the trust boundary (per boundary-discipline). A `LocalStore<C>` generic would push schema types into the storage layer with no gain at runtime. Brand constructors (`RecordId`, `Stamp`, `AeadKey`) cast inside their own module only. No optional field is always set: `Envelope.origin` is required, and `SpaceRequest` is a union per request kind, not one shape with optional fields.

### Red-flag screen

- **Split ownership.** Each key prefix has one writer.
  - `LocalStore` writes `73 01`–`05`, `07`, `09`–`0A` and the record, rich-text and file outboxes. A record's delete must remove its index entries, rich text and files in one transaction, so a single module owns all of them.
  - `SpaceRegistry` writes `73 06`, `08` and the membership requests (`73 04 02`).
  - `openSpaces` writes the account meta key once, on first open.
  - `FileStore` and `RichTextFields` call `LocalStore` and never write kv themselves.
- **Information leakage.**
  - The key layout is only in `local/keys.ts`.
  - The wire format is only in `sync/protocol.ts`, which the server imports.
  - The membership rules are only in the server session. Clients learn their standing from `authOk` and `denied`.
  - Crypto formats are only in `space/crypto.ts`.
- **Two ways to do one task.** `create`, `update` and `delete` are one-op `transact`s, so there is one write path. Positions come only from `between`.
- **Hand-synced lists.**
  - `ReservedName` is derived from the handle's own type, so it cannot drift from the handle.
  - Limits are one `const`.
  - Field kinds carry one symbol tag.
- **Importable internals.** `package.json` `exports` has `.`, `./testing` and `./server` only.
- **Temporal decomposition.** Modules follow knowledge: record format, merge, layout, membership, wire. `sync/engine.ts` is the one flow-shaped module, and it owns a real boundary: decrypting and validating on the way in, sealing on the way out.

## Synthesis decision

Three candidate designs were sketched independently, then scored by a separate reviewer.

- **spaces** (this shape, unconstrained): a sealed state per record, a server compare-and-set, a signed control log.
- **cells** (seeded: state-based): per-field cells, a server that merges by cleartext header, epoch keys derived from the owner seed and the removed-member set.
- **journal** (seeded: log-based): per-device sealed op batches, a version-vector cursor, checkpoints in a sequenced control chain.

The reviewer scored journal 25, spaces 23, cells 23 and recommended journal.

**Base: spaces, against the reviewer.** All three converged on the data layer: per-field last-write-wins cells with HLC stamps, a terminal tombstone, fractional-index lists, plaintext at rest, crypto only at the wire, the outbox in the same kv batch as the data, one sync tab per device with kv as the tab bus, and 1 MiB chunks under a per-file key that lives inside the record. They differ on the sync unit, and that decides how the design ages. The reviewer's own findings favor state over logs:

- Journal's checkpoints are written by any writer and cannot be checked once the batches they cover are dropped, so a checkpoint that omits a tombstone resurrects the record for every later joiner.
- A journal device that loses acked batches to a power loss can reissue a log position with different bytes, which forks two peers forever.

A state per record has neither failure: there is no position to reuse and nothing to compact. Of the two state-based sketches, spaces has the typed surface that compiles against its usage (the cells surface was stubs), the rotation check with exact recipient-set equality, and the most complete file and rich-text deletion protocol.

**Fixed from the reviewer's notes on spaces.**

- *Keyed-id resurrection.* A local write now reads the tombstone key. The server answers any item for a tombstoned record with the tombstone as a conflict, instead of a `gone` list the engine never applied. One conflict path covers both.
- *Tab bus.* The `follower` status no longer mentions BroadcastChannel. kv is the only channel between tabs.
- *Peer cursor.* The HLC change index, whose proof did not hold across a clock set back, is gone. P2P reconciles state instead.

**Grafted.**

- From cells: fingerprint reconcile for P2P, and the server incarnation, so a device whose server lost data re-pushes its state.
- From the reviewer: an index query reads its entries and rows in one pinned view.
- Subtracted: foreign records (`73 0C`). A record of an undeclared collection is skipped on pull, and the upgrade rebuild resets the pull cursors instead.

**Rejected.**

- Cells' owner-derived epoch keys. They are race-free, but they allow only one owner and give no forward secrecy if the seed leaks.
- A clamp on remote stamps far in the future. Replicas that clamp at different times diverge.
- Journal's signed batches. A signature per record state brings back Jazz's receive cost. It stays the "signed spaces" open question.

**Owner decision after synthesis: no key rotation.** The owner dropped rotation. Encryption only has to hide data from the server, and the server can enforce membership. That deletes the signed control log, epochs, key boxes, the key chain, Ed25519 and X25519, and v0's rotation step. Authorization moves to bearer-token hashes, journal's shape, and keys travel only through invite links and the personal space. The cost is in "What removal does not do".

**Design review.** A review of the synthesized sketch under the no-rotation model found 21 issues.

- **Applied to the sketch.** Item ids must carry their space's tag, checked by server and device (critical: a writer of one space could write into another). Page and commit item caps. Conflicts never skipped, and echo filtering only for rich text. Idempotent `join`, `create`, `remove` and `leave`. Removal revokes the member's invites. Heal rules for a server that lost a space. Key backup before data. Random member tokens per membership. Validators constrained to JSON and idempotent. Cheap schema bumps. The cursor follows own pushes. Base rev in its own key. Logarithmic `between()`. Invites refused on the personal space. A key check value. Stamp bound, unset cells, and peer proof direction.
- **Recorded for v1.** Rich-text compaction and the file lifecycle, in their sections. A count of unreadable records. The leader in a hidden tab.
- **Rejected.** Collections under `db.c.*`: top-level collections read better and `ReservedName` already guards them. Deriving a created space's key from the account secret: the key-backup rule covers the same loss with one mechanism. Revoking every invite on any removal: revoking the member's own invites is enough and keeps shared links working.

## Tradeoffs accepted

- **Device trust.** We accept plaintext at rest on the device (origin-private OPFS and IndexedDB) in exchange for no crypto on any local read or write, working indexes and `valueContains`, and synchronous merges inside `kv.update`. The zero-knowledge promise covers the server, not a compromised device.
- **No intent-preserving merge.** We accept per-top-level-field last write wins, so a concurrent edit to the same field loses and a nested object is replaced whole. In exchange, a merge is a few lines of pure code with no per-op history.
- **No list CRDT.** We accept that items inserted concurrently at one spot are ordered by a random suffix rather than by intent, in exchange for no sequence CRDT, no tombstones per element, and lists that are queries.
- **Record metadata at the server.** We accept that the server sees each record's id, size, push time and pushing member, plus deletions and rich-text field hashes. In exchange, storage is proportional to live data and catch-up costs one item per changed record.
- **Role enforcement by the server.** We accept that the server, not cryptography, enforces reader-versus-writer among members, with no proof of which member wrote what. In exchange, data items carry no signatures and nothing replays permissions. "Signed spaces" can come later as an opt-in.
- **Membership needs the server.** We accept that every membership change except `create` needs the server. Changes queue offline as requests and apply when it is reachable. In exchange, roles live in one place and nothing replays them.
- **No rotation.** We accept that a removed member keeps the space key, so ciphertext they obtain later, from a breach, a leaked backup or a colluding server, is readable to them, including data written after the removal. In exchange there are no epochs, key boxes, signatures or rotation races, and a removal is one ACL write. An app that needs a clean cut creates a new space and copies the data.
- **Tombstones forever.** We accept tombstones kept forever, about 40 bytes locally and 90 at the server, in exchange for deletion that never resurrects without a coordination protocol.
- **Single writes are not group-committed.** We accept one IndexedDB transaction per single write (`kv.update` does not group-commit, see "kv gaps"), in exchange for merging and checking the catalog inside the transaction with no retry loop. Bulk writes go through `transact`.
- **Records stay small.** We accept full-state record pushes rather than deltas, with records capped at 256 KiB, in exchange for a server that stores one item per record. Long text belongs in a rich-text field.
- **Records cannot move.** We accept that a record cannot move between spaces (the id carries the space), in exchange for prefix scans per space and refs that resolve with no lookup.
- **Account secret.** We accept that whoever copies the account secret is that account in every space, for good: the personal space cannot be re-keyed, and there is no device list to revoke. The remedy is a new account. In exchange there is no account server.
- **Invite links live with the key.** We accept that an invite link, plus its wrapped key at the server, opens the space for its life. An honest server drops a used link's wrapped key only when it is revoked; a breached server or an old backup keeps it. `join` strips the fragment from history, and invite expiry is an open question.
- **Spaces linked by connection.** We accept that one connection authenticates all of a device's spaces, so the server can link them by connection, in exchange for one socket per device.
- **Account secret on the device.** We accept that an account is a 32-byte secret on the device, with no recovery beyond `exportSecret`, in exchange for no account server.

## Alternatives considered

- **Per-device op logs with version vectors** (Jazz's session logs, compacted by snapshots).
  - **Exposes:** a log per device per space that grows with history, snapshot compaction that rewrites a whole space, and version-vector counters that must never go back.
  - **The flaw:** after a power loss kv can reissue them, and fixing that needs per-open sessions, which is Jazz's version-vector growth again.
  - **What it would hide:** it would let the server stay append-only.
  - **Why it lost:** the per-record compare-and-set hides more behind less state.
- **Build on docstore** (records as docstore documents with merge metadata inside, outbox and change feed as docstore indexes).
  - **The flaw:** docstore writes one collection per transaction, so a tombstone, its row deletion and its outbox entry cannot be atomic.
  - **Extra cost:** its plan-then-RETRY loop and catalog read add a round per write, and tombstones would sit in user indexes.
  - **What we keep:** its tuple encoding, query types and catalog rules, copied (see "kv gaps").
- **Encrypted at rest locally.**
  - **Cost:** a decrypt on every read, indexes only over blind tokens, and no `valueContains`.
  - **The flaw:** `kv.update` cannot await WebCrypto, so every merge would need a synchronous JS cipher (another dependency) or a plan-outside-validate-inside loop.
  - **Why it lost:** it protects against a threat (the device) that the owner's goal (a zero-knowledge server) does not name.
- **Siblings at the server** (Dynamo style: keep concurrent versions, and let clients supersede them by version vector).
  - **Exposes:** sibling sets to every reader.
  - **The flaw:** version vectors over devices break when a device's counter goes back after a power loss.
  - **Why it lost:** a compare-and-set on a server-assigned rev keeps one version per record and turns a regression into a retry.
- **One Y.Doc per space** (everything is Yjs, as in the whiteboard example).
  - **What it hides:** merging entirely.
  - **The flaw:** it loads a whole space into memory, has no indexes or typed queries, and its compaction rewrites the space.
  - **Why it lost:** it is right for the rich-text field and wrong for records.
- **Nested groups with inherited roles** (Jazz).
  - **What it hides:** sharing hierarchies.
  - **The flaw:** it is the source of every rotation bug in the grounding.
  - **Why it lost:** an app that needs a hierarchy can model it as several spaces.

## Open questions and risks

- **Write authorization.** Is server-enforced write permission among members enough? Or does the owner want "signed spaces", one Ed25519 signature per pushed state, verified on pull, at Jazz-like receive cost but with no permission replay?
- **Device trust.** Is plaintext at rest on the device acceptable? A device-key wrap of kv values would cost crypto on every read.
- **Tombstone horizon.** Should tombstones expire? A horizon needs a "resync from scratch" path for devices whose cursor is older than it.
- **Invite expiry.** Should invites carry a server-side expiry? It is cheap, and it shortens the life of a leaked link.
- **Clean cut.** Is "create a new space and copy" enough for an app that must shut a removed member out of future data, or should it be one call?
- **P2P trust.** Peers can check only that the other side holds the key. Is that enough between different people, or should P2P be limited to one account's devices?
- **Clock skew.** A device with a clock far ahead wins every concurrent edit until others observe its stamps. Should the engine refuse remote stamps more than a day ahead? That would trade convergence for sanity.
- **Background throttling.** The sync leader is a tab, so a backgrounded leader tab can be throttled. Would it be better to run the engine in kv's SharedWorker (see "kv gaps")?
- **Size caps.** Are the 256 KiB record cap and the 64 MiB file cap acceptable until kv grows a blob store?
- **Schema skew.** A newer app version that tightens a required field hides records from older versions (`unreadable`). Is a lint ("new fields must be optional or have a default") enough?

## v0 cut

v0 proves the shape on kv's Node harness: `fake-indexeddb/auto`, `openHarnessDb({ name, forceMemory: true })`, two names for two devices and two opens of one name for two tabs, `testServer()` for the in-process server, and `alwaysLeader`. It lands in two verifiable steps.

| Step | Modules | Lines | Proves |
|---|---|---|---|
| 1. Local | `schema`, `db`, `ids`, `errors`, `local/*` (without the rich-text and file methods) | 1,800 | Typed create, update, delete, get, query, resolve, watch, transact. Per-field merge across two tabs. Stale-schema refusal. A rebuild that adds an index. Read speed close to docstore's `get` |
| 2. Sync | `space/crypto`, `space/spaces`, `sync/protocol`, `sync/engine`, `testing`, `server/*` | 1,800 | Two devices converge on concurrent field edits, with the conflict, merge and retry. A pull after a restart resumes from the cursor. A device whose kv is destroyed (`destroyDb`, the extreme case of a power-loss regression) reopens with the same account secret and gets every pushed write back. A tombstone beats a concurrent edit and never resurrects. The server holds only ciphertext (`inspect`). Invite, join and remove: a removed device gets `denied` and its pushes are refused. A server that adds itself to the ACL gets no key |

Tests add about 2,500 lines. Deferred: `files.ts` and `richtext.ts` (v1, about 500 lines together), the `websocket` transport and a SQLite or Durable Object `ServerStore` (v1), peer-to-peer (`sync/peer.ts`, v2), tombstone horizon, and `space.forget()`.

Core bundle estimate: 12 to 16 kB gzip on top of kv, with zero crypto dependencies. zod is the app's own copy. yjs loads only on the first rich-text `open`.

## kv gaps

Ranked by what they cost this package. The first three were confirmed while building the local layer.

1. **Group-committed `update`.** `put` and `batch` share one IndexedDB transaction per group, but each `update` opens its own. Every write here is an `update`, because the merge runs inside its body, so single-write throughput is one IndexedDB transaction per write. That includes each rich-text keystroke. `update` calls issued in the same tick should share a transaction, with bodies run in order.
2. **Range reads inside `update`.** An `update` reads only point keys named up front. A step that must see a range and write atomically has to read it outside and hope: re-queueing a space runs in chunks, the reset of flagged cursors lists them before its update and can miss one written in between, and the rich-text trim counts the outbox before its update. A bounded range in `keys`, handed to the body like point values, would close all three.
3. **`rangeJoin` on `ViewSnapshot`.** `Db.rangeJoin` pins its own state, so a query cannot join its index range and then resolve refs in the same snapshot. Queries here use `snap.range` plus a batch of `snap.get`s instead.
4. **Origin on change events.** `Db.writerId` exists, but `append` events do not carry it. Rich-text keys carry an origin field only so a lease can skip its own updates, and watchers cannot tell local writes from remote ones ("saved" versus "synced").
5. **Blob store.** Large immutable values outside the LSM: write an OPFS file, then a manifest key in kv, last, so the scheme stays crash-safe and compaction never rewrites the bytes. That would lift the 64 MiB file cap and the 4 MiB rich-text state cap, and take files out of the 8 MiB batch budget.
6. **Background tasks in kv's SharedWorker.** kv already runs one SharedWorker per database. If a layer could run its background loop there with read and write access, sync would need no leader election and would not be suspended with a hidden tab.
7. **Keys-only scans.** A range copies every value. The file sweep and the P2P fingerprint scan need keys, or a small value prefix, only.
8. **`@opfs-lsm/kv/tuple`.** Export the order-preserving tuple codec, with its rule for what may follow a tuple in a key, so docstore and this package share one copy.

## Next implementation step

Step 1 (local) and the server and codec half of step 2 are built and tested; `HANDOFF.md` has the status. Next: `SpaceRegistry` with the internal `$spaces` collection, the `openSpaces` facade, then `SyncEngine`, `testServer` and the step 2 integration tests. Start with one test: two devices on one in-process server converge on concurrent edits to different fields of one record.
