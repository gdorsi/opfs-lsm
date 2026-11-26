# A document store on an ordered key-value store

Status: shipped. docstore follows the design this survey proposed ([docstore README](../../packages/docstore/README.md)). The key layout is in the header comment of `packages/docstore/src/keys.ts`, and the value encoding is kv's "Tuple keys" ([kv README](../../packages/kv/README.md#tuple-keys)). Not built: a keys-only scan flag, and live queries matched by key range.

Date: researched 2026-11-09 at commit `10f7f99`, before docstore existed. Nothing was run. External sources were fetched on 2026-11-09.

## Question

How do existing systems build a document store on an ordered key-value store? Which of their choices fit a small browser library, and what did kv lack for it? Index maintenance is settled in [derived-index-prior-art.md](derived-index-prior-art.md).

## What shipped, against the proposal

- **Keys.** One root byte, a catalog key, then short numeric ids from the catalog, never reused: a u16 collection id, a u8 index id, index 0 for the rows. A non-unique entry ends in the raw id. A unique entry's value is the id. Shipped as proposed, under root byte `0x64`, plus entries with included fields and text entries.
- **Values in keys.** FoundationDB's tuple rules cut to JSON scalars. Shipped in kv as `@opfs-lsm/kv/tuple`, not in the document store.
- **Documents.** JSON, with entries derived from the parsed stored form, as IndexedDB derives keys from its clone. Shipped. The cost of the parse was not measured.
- **Catalog.** One key holds the format, the app version, and the ids. Every write reads it in its `update` and plans again when it changed. An older app version keeps maintaining what the stored catalog lists. Equal versions with different specs is an error. Shipped, with a `failed` index state added.
- **Backfill.** `building`, then chunked idempotent passes, then `ready`. A crash starts over, and open waits. Shipped. It differs in two ways. A unique conflict marks the index `failed` and open resolves, where the survey proposed failing the open. There is no option to open without waiting.
- **Clear.** Shipped as one kv range delete over the collection, in the write that updates the catalog. The collection keeps its id.
- **Query.** One index range per query, no planner: equality on the first fields, one range or `startsWith` on the next, `limit`, an exclusive cursor, `reverse`, and `count`. Shipped as `query`, `queryIds`, `queryEntries` and `count`. Added since: `offset`, lists of values in `eq` merged like SQL `IN`, and included fields.
- **Unique.** A point key checked inside `update`. A put asks for the owners of its unique values up front. `modify` runs `fn` in the transaction and reads the owners of the unique values it takes with `tx.read` (item C).
- **Not shipped.** `patch`, and `subscribe(query)` with key-range matching. docstore has a per-collection `changes` feed that carries the documents.

## What kv lacked on 2026-11-09

| Item | Rating then | Now |
|---|---|---|
| A. Reverse scan | must-have | shipped, `reverse` on a range (design.md, "Reads") |
| B. Changed keys on `changes` | must-have for live queries | shipped, every event carries its ops (design.md, "Change events") |
| C. Reads inside the `update` body | worth-having | shipped, `tx.read` in the body (kv README, `update`) |
| D. Keys-only scan and count | worth-having | `count` shipped and copies nothing. No keys-only flag |
| E. Range delete | worth-having | shipped (design.md, "Range deletes") |
| F. Atomic writes over the batch limit | not-needed | not built. The batch limit is 8 MiB with no op cap (design.md, "Limits") |
| G. Snapshots across calls | present | `view` |
| H. A reserved keyspace | not-needed in kv | docstore owns keys that start with `0x64`, by convention |
| I. Async `update` bodies | not-needed | not built |
| J. Range statistics | not-needed | not built |
| K. Merge operators | not-needed | not built |

Item F. No precedent needs atomic writes above its engine's limit. FoundationDB caps a transaction at 10,000,000 bytes and five seconds, and Record Layer builds a large index write-only, across many transactions. The `building` state is needed anyway for other tabs.

## Lessons from the `collections` package

Each one is a mistake docstore could repeat.

- **Derive old and new entries from the same form.** `collections` derived old entries from stored JSON and new ones from the caller's object, so a value that JSON changes, such as `-0` or a `Uint8Array`, gave the two sides different entries. A hand-written mirror of `JSON.stringify` drifts, and a round trip cannot.
- **Store the schema in the database.** A schema held only in JS let two app versions derive different keys and leave orphans, with no backfill.
- **Build bounds in one place.** Three query methods built bounds three ways, and a short `from` meant a prefix scan in one and a lower bound in another.
- **Remove by prefix, not by deriving entries again.** `clear` derived each row's entries and assumed four ops per row, which a row with many multi-entry keys broke.
- **No length prefix in a key.** A segment with a little-endian u16 length sorts by its length bytes first, so ids and byte strings did not sort by content. FoundationDB's tuple spec says a length-prefixed code "only allows range searches if the length is known beforehand".

## External facts kept

Key layout and uniqueness:

- Chromium's IndexedDB on LevelDB prefixes every key with «database id, object store id, index id», reserves id 0 for metadata, and never frees ids: "The ID space is assumed to be sufficient".
- CockroachDB makes every key field prefix-free, so keys need no lengths. A unique index keeps the primary key in the value "so that the KV layer detects constraint violations", and rows with an indexed NULL fall back to the non-unique layout.
- Record Layer and Chromium keep one layout and check uniqueness with a read inside the transaction instead.

Value encoding:

- The FoundationDB tuple layer orders `-0.0` before `0.0` and reserves `0xff`. Its first nested-tuple design was dropped for "ordering problems when one tuple was a prefix of another".
- CockroachDB, MongoDB KeyString and the Firestore SDK encode `-0` as `0`. CockroachDB and KeyString serve a descending field by inverting its bytes under a separate marker, because the terminators differ by direction.
- IndexedDB and JavaScript's `<` order strings by UTF-16 code unit. UTF-8 byte order is code point order. The two differ outside the BMP.

Documents and schema versions:

- The IndexedDB spec clones the value on `put` and extracts the key "with clone". Every browser store read here keeps structured clone, JSON or protobuf, and none ships its own binary codec.
- IndexedDB fails an older open with `VersionError`, waits for other connections to close on upgrade, and aborts `createIndex` on a unique violation. Dexie reopens at the installed version instead. RxDB throws `DB6` for one version with two schemas.
- Record Layer checks a metadata version in the store header at open, and each transaction reads that header. It builds a new index inline under 200 records, and otherwise as `WRITE_ONLY` across many transactions. A removed index is cleared as one contiguous range.
- The Firestore SDK backfills 50 documents per pass, the first after 15 seconds. Its queries use a half-built index plus the unindexed documents, which needs documents ordered by change time.

Queries:

- DynamoDB `Query` takes equality on the partition key, one sort-key condition, `ScanIndexForward`, a start key and `Select: COUNT`.
- Firestore runs every query on an index, so cost follows the result size, and a missing index is an error with a link. A descending sort needs a second index on the server.
- RxDB's planner re-sorts descending results because "most storages do not support descending indexes". The Firestore SDK's planner prices an index read at 4 to 8 times a scanned document.

Live queries:

- Dexie records the key ranges each read covered and each write touched, from the old and the new objects, and posts them on its own BroadcastChannel. Without the old value it marks the whole index.
- Replicache records the keys and scans a subscription read, reruns on a matching commit diff, and delivers only when the result is not `deepEqual` to the last.

## Rejected

- **A query planner (Mango, RxDB, MongoDB).** It needs cost rules, in-memory filters and sorts, and a full-scan fallback. DynamoDB, Firestore and Dexie show one index range is enough for app queries.
- **Descending keys by inverted bytes.** They would be baked into stored data, and a reverse scan serves one direction. Mixed-direction compound sorts are left out.
- **Fixed-width keys bounded by the schema (RxDB).** Every indexed field would need `maxLength` and numeric bounds.
- **A custom comparator (ArangoDB).** kv's bloom filters and block prefixes depend on byte order.
- **A database per schema version (Replicache, RxDB).** Both rely on a server or a migration to carry data across, and this store has neither.
- **Names in keys (`level` sublevels).** No indirection, so drop, clear and redefine would need every key rewritten.
- **Refusing old clients on every schema change.** A web deploy leaves old tabs open, and a stored catalog lets them keep writing correctly.
- **Lazy index cleanup with row versions (Chromium).** An eager diff is cheap here ([derived-index-prior-art.md](derived-index-prior-art.md)).

## Open, and what would change the design

- The JSON parse per written document was not measured. If it shows in put time, a strict validator replaces it.
- Hundreds of collections could make the one-key catalog costly per write. Then the catalog splits per collection, as Chromium's does.
- A need for `a asc, b desc` sorts adds a per-field descending flag with inverted bytes. It is additive.
- Range-conditional writes ("insert unless a row in this range exists") need item C.
- Binary or date index values reopen the document encoding.
- Old tabs that write bad data through a newer catalog would move docstore to refusing old clients.
- Live queries matched by key range are not built. kv events now carry the keys they need.

## Sources

- FoundationDB: https://raw.githubusercontent.com/apple/foundationdb/main/design/tuple.md, https://raw.githubusercontent.com/apple/foundationdb/main/documentation/sphinx/source/known-limitations.rst
- Record Layer: https://raw.githubusercontent.com/FoundationDB/fdb-record-layer/main/docs/sphinx/source/SchemaEvolution.md, `FDBRecordStore.java` in the same repository
- CockroachDB: https://raw.githubusercontent.com/cockroachdb/cockroach/master/docs/tech-notes/encoding.md, https://raw.githubusercontent.com/cockroachdb/cockroach/master/pkg/util/encoding/encoding.go
- MongoDB KeyString: https://raw.githubusercontent.com/mongodb/mongo/master/src/mongo/db/storage/key_string/key_string.cpp
- Chromium: https://chromium.googlesource.com/chromium/src/+/main/content/browser/indexed_db/docs/leveldb_coding_scheme.md
- IndexedDB: https://raw.githubusercontent.com/w3c/IndexedDB/main/index.bs
- Firestore: https://raw.githubusercontent.com/firebase/firebase-js-sdk/main/packages/firestore/src/local/index_backfiller.ts, https://firebase.google.com/docs/firestore/query-data/index-overview
- DynamoDB: https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Query.html
- Dexie: https://raw.githubusercontent.com/dexie/Dexie.js/master/src/classes/dexie/dexie-open.ts, https://raw.githubusercontent.com/dexie/Dexie.js/master/src/live-query/observability-middleware.ts
- RxDB: https://raw.githubusercontent.com/pubkey/rxdb/master/src/query-planner.ts, https://raw.githubusercontent.com/pubkey/rxdb/master/src/rx-database.ts
- Replicache: https://raw.githubusercontent.com/rocicorp/mono/main/packages/replicache/src/subscriptions.ts
