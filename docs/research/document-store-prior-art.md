# A document store on an ordered key-value store: prior art for the collections rebuild

Question: `packages/collections` will be deleted and rebuilt as a small document store on `@opfs-lsm/kv`. How do existing systems build a document store on an ordered key-value store, which of their choices fit a small browser library, and what does kv lack for this kind of layer? Follows `docs/research/derived-index-prior-art.md` (DIPA), which settled index maintenance: read the old row, diff, write in one transaction. Text search is out of scope (MEIA, LPFM) except for where it plugs in.

kv is not treated as fixed. Section 6 lists what the precedents rely on in their storage engine and whether kv has it. Section 8 gives two designs: one on kv as it is today, one after the must-have additions.

## Answer in twelve lines

1. Every close precedent puts three things in the keyspace: a metadata area, primary rows, and index entries, under short numeric ids, not names. Chromium's IndexedDB on LevelDB, CockroachDB, TiDB and ArangoDB all do this (2.1). The ids buy indirection: drop, clear and redefine become "retire the id", so old entries can never be read as the new index.
2. Non-unique index key: `ids + encoded values + primary key`, empty value. Unique index key: `ids + encoded values`, value is the primary key. CockroachDB, TiDB and ArangoDB agree (2.2). The unique form is a point key, so today's `update(keys, body)` can enforce it.
3. Value encoding: FoundationDB's tuple rules are the smallest correct ones for JSON scalars: one type byte, big-endian double with flipped sign bits, UTF-8 string with `00 -> 00 FF` and a `00` terminator, nothing length-prefixed (2.3). Normalise `-0` to `0` as CockroachDB, MongoDB and the Firestore SDK do.
4. The trailing primary id needs no length prefix and no terminator, because every value before it is self-delimiting. That fixes id order and lets a prefix scan list a collection (2.2).
5. Documents: JSON text. IndexedDB derives keys from a clone of the value, not from the caller's object (2.4). Do the same: derive from the parsed stored bytes.
6. Index specs are data, persisted in the database with a version: IndexedDB, Chromium, FoundationDB Record Layer, RxDB (2.5). Because specs are data, a tab on an old app version can keep maintaining indexes it does not know about. Only a library format bump has to stop it.
7. New index on existing data: add it as "write-only", backfill in many small transactions, then flip to readable. Record Layer and the Firestore SDK both do this (2.5). It needs no large transaction.
8. Query model: one index range per query, no planner. DynamoDB, Replicache, IndexedDB and Firestore all work this way; the planners (Mango, RxDB, MongoDB) are where the size goes (2.6).
9. Direction belongs to the query, served by a reverse scan (FoundationDB, IndexedDB, DynamoDB). Inverted-byte keys exist for mixed-direction compound sorts and for engines with no reverse scan (2.6). Leave them out; add reverse scan to kv.
10. Live queries need the changed keys. Dexie builds its own cross-tab feed of key ranges because IndexedDB has none; Replicache diffs each commit (2.9). kv's bus message already carries the ops; the public event drops them (R1.2).
11. kv gaps, in the order they simplify the document store: reverse scan (must-have); changed keys in `changes` (must-have for live queries); reads inside the `update` body; keys-only scan and count; range delete. Not needed: larger batches, longer snapshots, a reserved keyspace, async bodies, statistics, merge operators (section 6).
12. Recommendation in section 8. Smallest coherent design: catalog key plus short ids, tuple-encoded values, JSON documents with keys derived from the stored form, declarative indexes with `building` and `ready` states, one `query` method.

---

Conventions as in DIPA. **[R]** repo fact, cited `file:line`. **[E key]** external fact; keys resolve in section 10. **[I]** my inference. Nothing was run in this task.

Method. Every external file was downloaded with `curl` and read locally as raw source or raw documentation text. No summarising fetch was used. Four documentation pages are HTML that I stripped to text locally before reading (Firestore data types and index overview, DynamoDB `Query`, MongoDB comparison order and index builds); quotes from them are exact but the stripping loses layout. Line numbers are from the default branch on 2026-11-09. Large files (`key_string.cpp`, `FDBRecordStore.java`, `encoding.go`, the IndexedDB spec) were read by search, not end to end; section 9 says where that limits a claim.

---

## 1. Repo facts

### 1.1 What kv offers today

- [R] Keys and values are bytes compared as unsigned bytes (`packages/kv/src/bytes.ts:2-9`). Limits: key 8 KiB, value 16 MiB, 10,000 ops and 8 MiB per batch (`check.ts:3-8`).
- [R] `Range` is `{start, endExclusive, limit, valueContains}` (`db.ts:137-147`). There is no direction flag and no keys-only flag; an `Entry` always has a value (`db.ts:149`). The scan cursor has `peek` and `next` only (`store/cursor.ts:21-24`).
- [R] `BatchTx` has `put` and `delete` (`db.ts:151-154`). There is no range delete.
- [R] `update(keys, body)` reads a fixed list of point keys and writes in one IndexedDB transaction; `body` is synchronous (`db.ts:168-176`, impl `:847-863`). It catches up with other tabs inside the transaction, before the body runs (`docs/design.md:441`).
- [R] The internal write path is more general than `update`: `write(plan, warm)` runs a synchronous `plan` against the caught-up memtable and levels; a `plan` that touches a page not in memory returns a `Miss`, appends nothing and is retried after the page loads. "Awaiting inside the transaction would commit it" (`db.ts:737-784`).
- [R] `rangeFollow` scans and point-reads in one task, one state (`db.ts:177-184`, `:865-891`). `view(body)` takes an async body and pins the memtable and the generation for as long as the body runs (`db.ts:186-190`, `:908-928`). The pin copies chunk references; later writes copy a shared chunk before changing it (`docs/design.md:155-158`). A generation held by a view keeps its run files from being released (`db.ts:401-405`).
- [R] The run manifest holds a path (which names level and byte size) and a key range per run, nothing per prefix (`store/generation.ts:19-24`, `store/levels.ts:8-9`).
- [R] SST blocks store one shared key prefix per block; the design notes this was done for collections' index keys, which "repeat about 20 bytes" (`docs/design.md:204-228`).

### 1.2 The change feed

- [R] The public event is `{kind, writerId, seq?}` (`changes.ts:3-8`).
- [R] The BroadcastChannel message that feeds it is `{kind, writerId, seq, ops}`: it already carries the batch's ops (`db.ts:418-423`). The writer posts it after its own commit (`db.ts:731-735`). A receiving tab applies the ops to its memtable and then emits the event without them (`db.ts:475-489`). If the message does not follow the tab's applied seq, the tab reads the WAL tail instead (`db.ts:478-480`, `docs/design.md:433-436`).

### 1.3 What the current collections package does

Each of the six review findings, located:

1. [R] `putMany` derives the old entries from the stored JSON (`decodeJson(prev)`) and the new entries from the caller's in-memory object (`table.ts:268-270`). The row is stored through `JSON.stringify` (`codec.ts:142-144`). `asIndexValue` accepts `Uint8Array` (`table.ts:126`), which JSON does not round-trip. Only the search key normalises `-0` (`table.ts:130-147`).
2. [R] The schema is a JS `Map` built at open (`database.ts:12-25`). Nothing is written to the database.
3. [R] `where` (`table.ts:402-421`), `orderBy` (`:427-463`) and `page` (`:302-346`) each build bounds. In `orderBy`, a `from` shorter than the index arity turns into a prefix scan, a full-arity `from` is a lower bound (`:442-456`).
4. [R] `clear` scans only the primary prefix `t/<table>`, re-derives each row's entries, and assumes "4 ops each" for 1,000 rows per batch (`table.ts:91-92`, `:352-386`). A row with many multi-entry keys breaks the assumption.
5. [R] Table name, index name and the trailing id are each `u16le length + bytes` (`codec.ts:11-21`, `:57-82`). Such a segment sorts by its length bytes first (low byte, then high byte), then by content, so not in id order.
6. [R] The byte-string index type is also length-prefixed (`typed.ts:83-89`), so it does not sort by content either.

---

## 2. Findings by question

### 2.1 Key layout: namespaces and ids (question 2)

| System | Keyspace | Prefix | Where the schema lives |
|---|---|---|---|
| Chromium IndexedDB on LevelDB | one | `database id, object store id, index id`, packed ints; id 0 is metadata | keys under `db id, 0, 0`: store name, key path, index name, unique flag, key path, multi-entry flag |
| CockroachDB | one | table ID, index ID | system tables |
| TiDB | one | `t{tableID}_r{rowID}`, `t{tableID}_i{indexID}...`, `m` for metadata | `m` keys |
| ArangoDB on RocksDB | one per column family | 8-byte object id per collection and per index | definitions, own key type |
| FoundationDB directory layer | one | short allocated prefix per path | node subspace, with a version key |
| MongoDB on WiredTiger | one table per collection and per index | none in the key | catalog table |
| PouchDB, `level` sublevels | one | names: `!name!key` | none, or a design doc |
| Replicache | one map for rows, one map per index | none; the app prefixes its own keys | index definitions in client-group state |

- [E chr-coding] "Each key in the backing store starts with a ternary prefix: «database id, object store id, index id». For each, the id `0` is always reserved for metadata" (lines 6-10). "The prefix makes sure that data for a specific database, object store, and index are grouped together" (13-17). Global metadata under `«0, 0, 0»` includes a "backing store schema version" and a "data format version" (154-156). Index metadata is four keys per index: name, unique flag, key path, multi-entry flag (266-269). Object store data lives under reserved index id 1; a second "exists" entry per row lives under id 2 with only a version (277-297). Index data is `«db, store, index, index key, sequence number, primary key»` with value `version, primary key` (311-319). Free lists for ids "are no longer used. The ID space is assumed to be sufficient" (163-166).
- [E chr-coding] Chromium cleans index entries lazily: each row write gets a new version number and "entries are validated against the 'exists' entries, and records with old version numbers are deleted when they are encountered" (232-238). DIPA 3.6 covers why that family does not fit here.
- [E crdb-enc-md] Primary keys are "1. The table ID 2. The ID of the primary index 3. The primary key of the row ... CRDB encodes these fields individually and concatenates the resulting bytes. The decoder can determine the field boundaries because the field encoding is prefix-free" (37-50).
- [E tidb-tc] `tablePrefix = 't'`, `recordPrefixSep = "_r"`, `indexPrefixSep = "_i"`, `metaPrefix = 'm'` (`tablecodec.go:50-53`).
- [E arango-key] `constructDocument(objectId, docId)` writes two 8-byte integers; `constructVPackIndexValue(indexId, indexValues, docId)` writes id, raw VelocyPack, doc id (`RocksDBKey.cpp:238-248`, `:278-291`). The VelocyPack bytes are not byte-comparable, so ArangoDB installs a custom RocksDB comparator (`RocksDBComparator.h`, class `RocksDBVPackComparator`). kv has no comparator hook, so this half of ArangoDB does not transfer.
- [E fdb-guide] "The directory layer maps each path to a short prefix used for the corresponding subspace. In effect, directories provide a level of indirection for access to subspaces" (143). "The indirection from paths to subspaces allows keys to be kept short and makes it fast to move directories (i.e., rename their paths)" (151). The cost: "you cannot use a single range query to read all contents of a directory and its descendants" (259).
- [E fdb-dir] The directory layer stores a version triple and refuses a newer major version; a newer minor version is read-only (`directory_impl.py:506-529`).
- [E level] A sublevel "prefixes the keys of operations before passing them on to `db`"; the prefix is `separator + name + separator`, default separator `!` (README 355, 378, 393).
- [I] Names versus ids. On disk the difference is small here, because a block stores its shared prefix once (R1.1). In the WAL, the memtable and the batch byte limit every key pays for the name. The stronger reason for ids is indirection: an index whose definition changes gets a new id, so nothing written under the old definition can be returned by the new one (finding 2), and clear or drop is a catalog edit followed by a sweep (2.5).
- [I] Put rows and index entries of one collection under one collection prefix (Chromium, CockroachDB, TiDB all do). Then one prefix scan covers everything the collection owns, and deleting it needs no derivation (finding 4).

### 2.2 Index entry shape and the primary key suffix (questions 2 and 7)

- [E crdb-enc-md] Secondary index key: table ID, index ID, indexed column data, then "If the index is non-unique or the row has a NULL in an indexed column, data from where the row intersects the non-indexed primary key (implicit) columns" (296-312). "Unique indexes relegate the data in extra columns to KV values so that the KV layer detects constraint violations ... rows with an indexed NULL cannot be involved in a violation. They need a unique KV key nonetheless ... which is achieved by including the non-indexed primary key data" (315-321).
- [E tidb-tc] `GenIndexKey` sets `distinct = true` for a unique index unless an indexed value is NULL, and appends the row handle to the key only when `!distinct` (`tablecodec.go:1235-1260`).
- [E arango-key] `constructUniqueVPackIndexValue(indexId, indexValues)` has no document id in the key (`RocksDBKey.cpp:293-304`).
- [E chr-coding] IndexedDB in Chromium keeps the primary key in the key for every index and checks uniqueness with a lookup instead (`index_writer.cc:35-86`, `VerifyIndexKeys` and `AddingKeyAllowed`).
- [E rl-sim] Record Layer keeps one layout and checks uniqueness with a range read inside the transaction: `state.transaction.getRange(state.indexSubspace.range(valueKey))` (`StandardIndexMaintainer.java:577`).
- [E rc-idx] Replicache index key: version byte, secondary key string, a null byte, the primary key. "Secondary keys must not contain a zero (null) byte" and only strings are indexable (`db/index.ts:101-119`, `:82-85`).
- [I] Two families for uniqueness: a point key whose value is the owner (CockroachDB, TiDB, ArangoDB), or one layout plus a range read in the write transaction (Record Layer, Chromium). The first works with a store that can only read point keys in a write, which is kv today.
- [I] The trailing primary key. In CockroachDB every field is prefix-free, so the decoder needs no lengths. If the indexed values are self-delimiting, the id can be the raw remainder of the key: no length prefix, no terminator. Rows then sort by id bytes, and `prefix + id` is a point key. This removes finding 5.

### 2.3 Order-preserving value encoding (question 3)

| Encoding | Type order (for JSON's types) | Numbers | `-0`, NaN | Strings | Descending | Arrays |
|---|---|---|---|---|---|---|
| FoundationDB tuple | null, bytes, string, nested tuple, int, double, false, true | ints and doubles are separate types, each ordered | `-0.0 < 0.0`; NaNs at both ends | UTF-8, `00 -> 00 FF`, terminator `00` | none | nested tuple, `00` terminator, nulls escaped |
| MongoDB KeyString | null, number, string, object, array, ..., bool | one numeric class across int, long, double, decimal | `-0` is the zero key plus a type bit; NaN is the lowest number | `00 -> 00 FF`, terminator `00` | per field, bytes inverted | elements then `00` |
| CockroachDB | NULL, float, ..., bytes | float tags: NaN, negative, zero, positive | both zeros are one tag; NaN first | `00 -> 00 FF`, terminator `00 01` | separate marker, bytes one's-complemented | marker plus terminator, nulls remapped |
| Firestore SDK index | null, boolean, NaN, number, timestamp, string, ... | one number type | `-0` written as `0`; NaN its own type below numbers | escaped, separator `00 01` | per segment, descending writers | own type |
| IndexedDB (spec) | number, date, string, binary, array | double | NaN is not a valid key; `-0` equals `0` | UTF-16 code unit order | cursor direction | element-wise |
| bytewise, charwise | null, false, true, number, date, buffer, string, array, undefined | double | NaN illegal | lexicographic | none | componentwise |
| pouchdb-collate | null, boolean, number, string, array, object | decimal string with magnitude | NaN and infinities become null | three-way escape, `\u0000` terminator | none | concatenation |
| RxDB custom index | per schema | zero-padded decimal, needs `minimum`, `maximum`, `multipleOf` | n/a | padded to `maxLength` with spaces | none | none |

- [E fdb-tuple] Null `0x00`; byte string `0x01` and Unicode string `0x02` are "null terminated with null values occurring in the string escaped in an order-preserving way"; double `0x21` is "Big-endian IEEE binary representation" with the sign bit flipped for positives and every bit flipped for negatives; false `0x26`, true `0x27`. The double order is "All negative NaN values ... Negative infinity ... All real numbers in the standard order (except that -0.0 < 0.0) ... Positive infinity ... All positive NaN values". `0xff` is reserved as the escape: "it would be a Very Bad Idea" to use it as a type code. The first nested-tuple design is deprecated because "it had ordering problems when one tuple was a prefix of another"; the current one terminates with `00` and escapes nulls inside.
- [E fdb-tuple] Length-prefixed byte strings (`0x34`, `0x35`) are reserved with the note "This typecode only allows range searches if the length is known beforehand". That is the defect of findings 5 and 6, stated by the owner of the format.
- [E ks] Type bytes: `kNullish = 20`, `kNumeric = 30`, `kStringLike = 60`, `kObject = 70`, `kArray = 80`, `kBool = 110` (`key_string.cpp:55-67`). Strings: "replace \x00 with \x00\xFF" and "final 0 termination" (`:1225-1235`). A double negative zero appends a type bit and is then encoded like any zero (`:880-886`). Per-field direction: `const bool invert = (ord.get(i) == -1)` (`:2686`), and every append takes `invert`. Bounds use discriminator bytes `kLess = 1` and `kGreater = 254` that "can't equal 0 or 255 since that would collide with the encoding of NUL bytes in strings" (`:303-309`, `:596-617`).
- [E crdb-float] "This encodes both positive and negative zero the same" (`float.go:37-39`). NaN has its own tag so that "NaNs are always sorted first in either encoding direction" (`:24-30`).
- [E crdb-enc] Bytes: `<term> -> \x00\x01`, `\x00 -> \x00\xff` (`encoding.go:613-621`). Descending: "encodes the []byte value using an escape-based encoding and then inverts (ones complement) the result" under a separate marker (`:705-715`), because "the terminators for these encodings are different depending on the direction ... we must store this information in the marker" (`:87-93`).
- [E fs-ivw] Type labels: `INDEX_TYPE_NULL = 5`, `BOOLEAN = 10`, `NAN = 13`, `NUMBER = 15`, `TIMESTAMP = 20`, `STRING = 25`, `ARRAY = 50`, `MAP = 55` (`firestore_index_value_writer.ts:57-75`). "-0.0, 0 and 0.0 are all considered the same" (`:210-213`). [E fs-types] The server orders "Null values ... Boolean values ... integer and floating-point values, sorted in numerical order ... Date values ... Text string values", strings in "UTF-8 encoded byte order", and "normalizes all NaN values, and considers it less than -Infinity".
- [E idb-spec] Type order: array > binary > string > date > number (`index.bs:643-653`). Numbers compare by greater and less (`:665-667`), so `-0` and `0` are one key [I]. NaN is "invalid value" (`:6521`). Booleans, null and objects are not keys.
- [E bytewise] Order as in the table (README 21-29). "`NaN` is also illegal anywhere in a serialized value" (39). It suggests that to match CouchDB "you could round-trip values through a `JSON` encode cycle ... before passing to `encode`" (190).
- [E charwise] Written because "bytewise is too slow ... quite visible effects on a bulk load".
- [E pc] `normalizeKey` turns `undefined`, NaN and the infinities into `null` and a `Date` into its JSON string before encoding (`index.js:36-54`). Strings are escaped three ways so `\u0000` can terminate (`:79-88`).
- [E couch-coll] CouchDB orders `null, false, true`, numbers, strings, arrays, objects, and "Comparison of strings is done using ICU" (lines 116-157). ICU order is not byte order, so CouchDB cannot be the model for a byte-comparing store.
- [E rx-ci] RxDB builds one fixed-width string per document: strings `padEnd(maxLength, ' ')`, booleans `'1' : '0'`, numbers shifted by the schema minimum and zero-padded (`custom-index.ts:73-135`). The schema must bound every indexed field.

[I] The smallest correct choice for JSON documents is the FoundationDB tuple rules cut down to JSON's scalars:

- Types: null, false, true, number, string. One tag byte each, ascending in that order (the order CouchDB, PouchDB, bytewise and Firestore share). Never use `0xff` as a tag.
- Number: JSON has one number type, so only the 8-byte double form is needed. FoundationDB's separate integer codes, KeyString's unified numeric class and CockroachDB's decimals all exist for types JSON does not have.
- `-0`: encode as `0` (CockroachDB, KeyString, Firestore). FoundationDB keeps them apart, which is wrong for a store whose document encoding drops the sign.
- NaN and infinities: cannot occur if keys are derived from stored JSON (2.4).
- String: UTF-8, `00 -> 00 FF`, terminator `00`. A prefix of the string is a prefix of the encoding without its terminator, so "starts with" is a plain prefix scan.
- No length-prefixed type (finding 6). No bytes type: JSON has none.
- Order is UTF-8 byte order, which is code point order. JavaScript's `<` on strings is UTF-16 code unit order, as is IndexedDB's; the two differ for characters outside the BMP. Say so in the API docs.
- The current `typed.ts` number and string forms already follow these rules (`typed.ts:14-25`, `:43-63`); its terminator is two bytes where FoundationDB uses one.

### 2.4 Document encoding (question 4)

- [E idb-spec] `put` and `add`: "Let clone be a clone of value in targetRealm during transaction", with the note "The value is serialized when stored. Treating it as a copy here allows other algorithms in this specification to treat it as an ECMAScript value" (`index.bs:3022-3031`). The in-line key is then extracted "with clone" (`:3033`). So IndexedDB derives keys from the stored form by construction.
- [E chr-coding] Chromium stores "version (VarInt), serialized script value" (286) and records the V8 and Blink serializer versions in a global "data format version" key (168-171).
- [E pc] PouchDB normalises a key to its JSON form before encoding it (2.3).
- [E rc-idx] Replicache reads the indexed value through a JSON pointer on the stored JSON value and accepts only strings or arrays of strings (`db/index.ts:65-90`).
- [E DIPA 3.1] Record Layer evaluates key expressions on the Protobuf message, which is the stored form. CockroachDB and MongoDB encode from typed datums and BSON elements.
- [I] What browser stores use: IndexedDB and Dexie use the browser's structured clone; RxDB, PouchDB and Replicache hold JSON; the Firestore SDK holds its protobuf value type. None of the ones read here ships its own binary document codec. I did not find a primary source that states the reason. The likely one is that `JSON.stringify` and `JSON.parse` are native and a JS-implemented CBOR or MessagePack is not, and that a binary codec adds types (bytes, dates, bigints) that then need an index order.
- [I] How to guarantee "the indexed value is the stored value": derive from `JSON.parse` of the bytes that will be written, as IndexedDB derives from the clone. It costs one parse per written document. The alternative is a strict walker that rejects anything JSON would change (`undefined`, NaN, `-0`, non-plain objects, `toJSON`). The walker is not smaller and has to mirror `JSON.stringify` exactly; the round trip cannot drift. Finding 1 is exactly a hand-written mirror that drifted.

### 2.5 Index declaration and lifecycle (questions 5 and 8)

**What is declared.** [E idb-spec] An index is a key path plus `unique` and `multiEntry`; a compound key path with `multiEntry` is rejected (`index.bs:3497`). [E rc-defs] Replicache: `{prefix?, jsonPointer, allowEmpty?}`, one path, strings only. [E fs-fi] Firestore SDK: fields, each `ASCENDING`, `DESCENDING` or `CONTAINS` (`field_index.ts:124-137`). [E DIPA 3.4] Dexie: a string with `&`, `*`, `[a+b]`. Partial indexes appear in CockroachDB (DIPA 3.1) and as Replicache's `prefix`; none of the small stores has predicates.

**Where it is persisted, and what open checks.**

| System | Persisted | Version | Old client meets a newer database |
|---|---|---|---|
| IndexedDB (spec) | object stores and indexes | integer | `VersionError` |
| Dexie | through IndexedDB | integer times 10 | reopens at the installed version and carries on |
| Record Layer | meta-data, plus a store header with the last meta-data version used | integer per change, per index | `RecordStoreStaleMetaDataVersionException` |
| FDB directory layer | version triple | major, minor, patch | newer major: refuse; newer minor: read-only |
| RxDB | collection document with schema, hash and version, keyed `name-version` | integer per collection | a different storage instance per version; same version with another schema is error `DB6` |
| Replicache | index definitions per client group | `schemaVersion` string | a different IndexedDB database per schema version |
| Chromium | all of it, plus backing-store schema version and data format version | integers | n/a (one browser) |

- [E idb-spec] "If db's version is greater than version, return a newly created VersionError" (`index.bs:5036-5038`). On an upgrade every other open connection gets a `versionchange` event and the upgrade waits for them to close (`:5044-5062`). `createIndex` only inside an upgrade transaction; a unique violation in existing data aborts with `ConstraintError` (`:3540-3546`).
- [E dx-open] On `VersionError` Dexie sets `nativeVerToOpen = 0` and opens again, which opens whatever version is installed (`dexie-open.ts:168-172`). If the declared schema has parts the database lacks: "Schema was extended without increasing the number passed to db.version(). Dexie will add missing parts and increment native version number to workaround this" (`:119-126`). [E dx-dexie] The default `versionchange` handler closes the connection so the other tab's upgrade can go on (`dexie.ts:219-241`).
- [E rl-evo] "storing the version of the last meta-data used in the header of each record store and checking this version against the current meta-data's version whenever the record store is opened" (11). Versioned: the whole meta-data, "the version at which an index was first added and the version at which its definition was last changed", and removed indexes (15-20). [E rl-store] `oldMetaDataVersion > newMetaDataVersion` fails the open (`FDBRecordStore.java:5044-5049`); the store header key is added as a read conflict (`:2909`), so a transaction that raced a header change fails.
- [E rx-db] The collection document holds `schemaHash`, `schema`, `version` (`rx-database.ts:365-378`). A second writer with the same name and version but another schema gets `DB6` (`:462-490`). The key is `name + '-' + schema.version` (`rx-database-internal-store.ts:400-402`).
- [E rc-name] `rep:${name}:${formatVersion}` plus `:${schemaVersion}` when set (`make-idb-name.ts`). [E rc-clients] A new client looks for a client group with equal mutator names and index definitions, and otherwise forks one (`persist/clients.ts:286-340`).

**Index states and backfill.**

- [E rl-state] `READABLE`; `WRITE_ONLY`: "the index should not be read from but is written to. This is the state that an index should be in while it is being built"; `DISABLED`; `READABLE_UNIQUE_PENDING`: "fully indexed, but some uniqueness violations still exist". Two more write-only variants exist to avoid conflicts between the indexer and user writes (`IndexState.java:39-83`).
- [E rl-evo] "If there are only a few records, by default less than 200, in the record store, the transaction that is opening the record store will scan them to populate the index and it becomes readable immediately" (98). Otherwise "the index is marked write-only instead. The client can use the OnlineIndexer to build the index in as many separate transactions as needed ... since the index is write-only, changes to the record store will themselves keep it up to date, avoiding a situation where the online indexer can never catch up" (100). A changed definition under the same name: "the index will be marked write-only and the user should clear out the index" (110). A removed index: "all of the data for the index are cleared. This is a cheap operation because the index is contiguous" (106).
- [E fdb-lim] The reason Record Layer builds in many transactions: "Transaction size cannot exceed 10,000,000 bytes of affected data" and no transaction may run over five seconds. kv's 8 MiB batch limit is the same order.
- [E fs-bf] The Firestore SDK backfills in the background, 50 documents per pass, first pass after 15 seconds (`index_backfiller.ts:38-44`). [E fs-fi] Each index keeps a high-water mark, "how updated the Index is" (`field_index.ts:160-172`). [E fs-qe] Queries use a partly built index and add "documents that have not yet been indexed" (`query_engine.ts:100-104`, `:317-348`). That needs documents ordered by change time, which this store does not have.
- [E mongo-build] MongoDB holds an exclusive lock "briefly at the beginning and end of the index build"; for a unique index it "checks all pre-existing and concurrently-written documents for violations ... after the index build completes" and aborts the build on a violation.
- [I] What transfers. (a) Specs are data, so every writer derives entries from the persisted catalog, not from its own code. An old app version then maintains indexes it never declared, as IndexedDB does for Dexie. (b) A monotonically increasing app version decides who may change the catalog; equal version with different specs is an error (RxDB `DB6`), not a silent patch (Dexie), because two live tabs would otherwise rewrite each other's schema. (c) A separate library format number is the only thing that must stop an old client (directory layer, Chromium). (d) Two states are enough: `building` (written, not read) and `ready`. (e) Every write transaction must notice a catalog change. Record Layer does it with the store header in each transaction; here the catalog key goes in the `update` key list and costs one in-memory get (DIPA R1.4).

### 2.6 Query model (question 6)

- [E ddb-query] DynamoDB `Query`: the key condition "must perform an equality test on a single partition key value" and may add one sort-key condition among `=`, `<`, `<=`, `>`, `>=`, `BETWEEN`, `begins_with`. `ScanIndexForward` false reverses. `Limit` and `ExclusiveStartKey`/`LastEvaluatedKey` page. `Select: COUNT` "Returns the number of matching items, rather than the matching items themselves".
- [E rc-scan] Replicache `scan`: `prefix`, `start: {key, exclusive}`, `limit`, `indexName`. No end bound, no direction, no count.
- [E idb-spec] `IDBKeyRange` with open or closed bounds, cursor directions including `"prev"`, `count`, `getAllKeys`, `openKeyCursor`. The third edition added `getAllRecords` and a direction option on `getAll` and `getAllKeys` (`index.bs:6912-6913`).
- [E dx-where] Dexie has no planner: `where(index)` names the index, then `above`, `aboveOrEqual`, `below`, `belowOrEqual`, `between`, `equals`, `startsWith`, `anyOf`, plus `reverse`, `limit`, `offset`, `count`, and a JS `filter` (`where-clause.d.ts`, `table.d.ts`).
- [E fs-idx] "Cloud Firestore helps provide high query performance by using indexes for all queries. As a result, query performance depends on the size of the result set and not on the number of items in the database." A query with no index "returns an error message with a link that you can follow to create the missing index". Firestore keeps "two collection-scope indexes, one in ascending mode and one in descending mode" per field, and "to run the same queries but with a descending sort order, you need an additional index in the descending direction".
- [E pf] PouchDB find picks an index, filters the rest "in memory" (`inMemoryFields`), and falls back to `_all_docs` with the warning "No matching index found, create an index to optimize query time" (`find/index.js:136-174`).
- [E rx-qp] RxDB's planner computes start and end keys per candidate index, tracks `inclusiveStart`, `inclusiveEnd`, `sortSatisfiedByIndex`, `selectorSatisfiedByIndex`, and rates plans (`query-planner.ts:34-211`). On direction: "Most storages do not support descending indexes so having a 'desc' in the sorting, means we always have to re-sort the results" (`:45-48`).
- [E fs-qe] The Firestore SDK's own planner prices an index read at 4 to 8 times a scanned document and has a minimum collection size of 100 documents for automatic index creation, which is off by default (`query_engine.ts:65-85`, `:129`).
- [E fdb-api] "Reading ranges in reverse is supported natively by the database and should have minimal extra cost" (`api-python.rst:845`). [E fdb-sub] A tuple range is `[packed + 00, packed + FF)`; bounds are built by byte arithmetic, not by a second encoding.

[I] Two models. Index-only (DynamoDB, Replicache, IndexedDB, Dexie, Firestore): the caller names the index, the query is one contiguous key range, cost is the result size. Planner (Mango, RxDB, MongoDB): the caller writes a predicate, the store picks an index and filters or sorts the rest in memory, and a missing index degrades to a scan. The planner is where the code and the surprises are. For a small store pick index-only and let the caller filter the returned page in JS, as Dexie's `filter` does.

[I] Smallest coherent query: an optional index name (omitted means the primary rows in id order); equality on the first k components; one optional range (`gt`, `gte`, `lt`, `lte`) or `startsWith` on component k+1; `limit`; an opaque `after` cursor that is the last key returned; `reverse`; `keysOnly`; and `count` over the same range. That is DynamoDB's `Query` shape and it replaces `where`, `orderBy` and `page` with one bound builder (finding 3). Inclusive and exclusive bounds are byte arithmetic on one encoding: `encode(v)` and `successor(encode(v))`, as FoundationDB and CockroachDB do. kv already has `successor` (`bytes.ts:12-22`).

[I] Descending. Engines with a reverse scan serve both directions from one index (FoundationDB, IndexedDB, DynamoDB). Inverted encodings (CockroachDB, KeyString, Firestore SDK) exist for two cases: a compound sort with mixed directions, and a server that will not scan backwards, where Firestore then pays for a second index. RxDB, with no reverse scan, re-sorts the whole result. The design that prior art supports is a `reverse` flag on the query and a reverse scan in the engine. Mixed-direction compound sorts are left out.

### 2.7 Uniqueness and constraints (question 7)

Covered by 2.2 for layout. In the write:

- [E DIPA 3.1] CockroachDB writes unique entries with `CPut`. [E idb-spec] IndexedDB aborts with `ConstraintError`.
- [I] On kv today: the unique key of the new document is known before the transaction, so it goes in the `update` key list with the primary key. In the body: if the unique key holds another id, throw; otherwise put it and delete the old row's unique key if it differs. Two documents with the same unique value inside one batch must be caught in JS before the write.
- [I] The case that does not fit is read-modify-write with a function (`modify(id, fn)`): the new unique key depends on the old row, which is only read inside the transaction. Two answers: an optimistic loop (read the row, compute, then `update([pk, uniqueKeys])` and write only if the row bytes are unchanged, else retry), or reads inside the body (section 6, C).
- [E crdb-enc-md, tidb-tc] SQL engines exempt NULL from uniqueness and then need the non-unique layout for those rows. [I] A document store can use a simpler rule: a missing path is not indexed at all (IndexedDB, DIPA 3.1), and `null` is a value like any other.

### 2.8 Data model and API surface (question 1)

| Store | Container | Ids | Writes | Reads | Left out |
|---|---|---|---|---|---|
| IndexedDB | object store | any key type, in-line or out-of-line | `add`, `put`, `delete`, `clear` | `get`, `getAll`, `getAllKeys`, `count`, cursors, indexes | patch, queries beyond one range |
| Dexie | table | as IndexedDB | `add`, `put`, `update`, `upsert`, `delete`, `clear`, `bulkAdd`, `bulkPut`, `bulkUpdate`, `bulkDelete` | `get`, `bulkGet`, `where`, `orderBy`, `filter`, `count`, `limit`, `offset`, `reverse` | planner |
| Replicache | none (key prefixes) | string keys | `set`, `del` inside mutators | `get`, `has`, `isEmpty`, `scan` | collections, patch, count, end bound, reverse, compound and non-string indexes, unique |
| PouchDB | database | string `_id` | `put`, `remove`, `bulkDocs` | `get`, `allDocs`, `find` | count, patch |
| Firestore | collection | string id | `set` (with merge), `update`, `delete`, write batch | `get`, query with cursors, `count()` | unique |

- [E dx-table] Dexie's `Table` type lists the methods above. [E rc-scan, rc-defs] Replicache's omissions are read from its option types.
- [I] The common core is: named collections; string ids; `get`, `put` (upsert), `delete`; bulk forms of each in one transaction; a merge-style partial update; one range query with limit and cursor; count. Unique indexes exist in IndexedDB, Dexie, MongoDB and the SQL-backed layers, not in Replicache or Firestore.
- [E idb-spec] What users asked for later, as far as a primary source shows it: IndexedDB's third edition added batch reads with direction (`getAllRecords`, the direction option) and explicit `commit` and durability control (`index.bs:6889-6913`). I did not read issue trackers, so I have no direct evidence for the smaller stores.

### 2.9 Live queries (question 9)

- [E dx-obs] Dexie records, per read, a set of key ranges per table and index (`obsSet`), and per write the ranges it touched (`mutatedParts`): primary keys, plus index ranges derived from old and new objects (`observability-middleware.ts:63-170`, `:204-232`). When old values are unknown it marks the whole index (`:136`).
- [E dx-bc] IndexedDB has no change feed, so Dexie posts the changed parts on its own `BroadcastChannel` and replays them locally in other tabs (`enable-broadcast.ts`). [E dx-lq] A live query reruns when `obsSetsOverlap(currentObs, accumMuts)` (`live-query.ts:90-97`).
- [E rc-sub] Replicache records the keys and scans a subscription body read, matches each commit's per-index diffs against them, reruns on a match and delivers only if the result is not `deepEqual` to the last one (`subscriptions.ts:35-113`).
- [E rx-db] RxDB works from a stream of document change events; `event-reduce.ts` exists to update results without a rerun. I did not read it.
- [I] The feed must carry at least the keys written. With keys, a query that is one key range (2.6) reruns only when a written key falls in its range; index keys are in the batch, so no document needs decoding. kv's public event carries no keys (R1.2), so today the only option is "rerun every live query on every event and compare", which is correct but wasteful. The keys are already on the wire.

---

## 3. What the current package got wrong, and who avoids it how

| # | Finding | How prior art avoids it |
|---|---|---|
| 1 | keys from the in-memory object | IndexedDB extracts keys from the clone (2.4); PouchDB and bytewise normalise through JSON first (2.3) |
| 2 | schema only in JS, no backfill, re-path under one name | persisted definitions with versions and ids (Chromium, Record Layer, RxDB); write-only then readable (Record Layer); a changed definition is a new index (2.5) |
| 3 | three query methods, mixed bound semantics | one range per query with equality prefix plus one range (DynamoDB); bounds by byte arithmetic (FoundationDB) (2.6) |
| 4 | `clear` re-derives keys | rows and entries share the collection prefix, so removal is by key range (Chromium, CockroachDB); Record Layer clears the contiguous range (2.1, 2.5) |
| 5 | length-prefixed ids | prefix-free fields, no lengths (CockroachDB); FoundationDB's own note on length prefixes (2.3) |
| 6 | no unique, count, keys-only | unique as a point key (CockroachDB, TiDB, ArangoDB); `COUNT` and key cursors as range operations (DynamoDB, IndexedDB) (2.2, 2.6) |

---

## 4. Where text search plugs in

[I] As one more index kind in the catalog. Its entries come out of the same derive step and the same diff (DIPA option i), its state machine is the same `building` then `ready`, and its query method is separate from `query` because it is not a key range. Adding a kind is a library format bump (2.5 c), since an older library cannot maintain it. LPFM's one-key-per-row design fits unchanged.

---

## 5. Options

| Decision | A | B | Pick |
|---|---|---|---|
| Namespace | names in keys (`level`, current code) | short ids from a catalog (Chromium, CockroachDB, TiDB, directory layer) | B: indirection for drop, clear, redefine |
| Unique | point key, value is the id (CockroachDB, TiDB, ArangoDB) | one layout plus a range read in the write (Record Layer, Chromium) | A: works on kv today and after |
| Value encoding | tuple subset (FoundationDB) | fixed-width by schema (RxDB) | A: no per-field schema needed |
| Document encoding | JSON, keys from the parsed bytes (IndexedDB rule) | JSON plus a strict validator | A unless a bench shows the parse matters |
| Old client | refuse (`VersionError`, Record Layer) | maintain from the persisted catalog (IndexedDB plus Dexie) | B, with a format number as the hard stop |
| New index | block open until built (IndexedDB upgrade) | `building`, chunked backfill, `ready` (Record Layer) | B; open may still wait for it by default |
| Query | planner (Mango, RxDB) | one index range (DynamoDB, Replicache) | B |
| Descending | inverted bytes per component (CockroachDB, KeyString, Firestore) | reverse scan (FoundationDB, IndexedDB, DynamoDB) | B; needs kv |
| Live queries | own BroadcastChannel in the layer (Dexie) | keys on kv's event | B; needs kv |

---

## 6. What kv needs

For each primitive the closest precedents get from their engine: whether kv has it, what the document store does without it, and a rating for a small document store.

**A. Reverse iteration.** Not in kv: `Range` has no direction and the cursor only moves forward (R1.1).
- Precedent: FoundationDB `reverse=True`, "supported natively" [E fdb-api 845]; IndexedDB `"prev"` cursors and the new direction option [E idb-spec]; DynamoDB `ScanIndexForward` [E ddb-query]; `abstract-level` `reverse`, with the note that "a reverse seek can be slower than a forward seek" [E level 296]. Document layers use it for newest-first lists and for "last N".
- Without it: (1) inverted-byte components declared per index. Direction is then fixed at declaration, the other direction needs a second index and its write cost (Firestore's model), and "last N by id" on the primary rows is impossible. (2) Read the whole range and reverse in memory (RxDB): cost is the range, not the page. (3) The app stores a negated sort value, which the current code already suggests (`table.ts:51`).
- Rating: **must-have**. It is the only gap whose workarounds all change the stored data or the cost class.

**B. Changed keys in the change feed.** Half there: the cross-tab message carries the ops, the public event drops them (R1.2).
- Precedent: Dexie builds this feed itself because IndexedDB lacks it [E dx-bc]; Replicache diffs each commit [E rc-sub]; CouchDB's `_changes` is the classic form (not read here).
- Without it: rerun every live query on every event and compare results. Or run a second BroadcastChannel in the document layer as Dexie does, but its messages are not ordered against kv's own apply, so a rerun can read before the write is visible in that tab [I].
- Caveats to design for [I]: a tab that missed a message catches up from the WAL tail (R1.2), so the event for that path must carry the keys read from the tail or say "unknown, invalidate everything", which is what Dexie does when it lacks old values. `ingest` events change no keys.
- Rating: **must-have for live queries**, worth-having otherwise. It is mostly plumbing that exists.

**C. Reads inside the write transaction.** Partly: `update` reads a fixed list of point keys (R1.1).
- Precedent: Record Layer's uniqueness check is a range read in the transaction [E rl-sim 577]; the Firestore SDK reads a document's existing index entries inside the write, through a lookup by document key that returns many rows (`indexeddb_index_manager.ts:797-811`, `:861-864`); FoundationDB transactions read anything and read their own writes [E fdb-api].
- Without it: unique indexes use the point-key layout (2.2), which is no loss. `modify(id, fn)` on a collection with unique indexes needs the optimistic loop of 2.7. Conditional writes that depend on a range ("insert if no row matches") are not expressible atomically.
- What it would take [I]: `write(plan, warm)` already runs a synchronous plan and retries on a page miss (R1.1). Exposing `tx.get` and a synchronous `tx.range` to the `update` body is that mechanism made public, with the rule that the body may run more than once. Reading the transaction's own pending writes is not needed: the layer builds every op itself.
- Rating: **worth-having**. Point `tx.get` removes the optimistic loop; `tx.range` is needed only for range-conditional writes.

**D. Keys-only scans and count.** Not in kv: every entry carries its value and the scan copies each record out (R1.1, `docs/design.md:409-410`).
- Precedent: IndexedDB `openKeyCursor`, `getAllKeys`, `count` [E idb-spec]; DynamoDB `Select: COUNT` and key-only projections [E ddb-query]; Chromium adds an "exists" entry per row so key and existence reads never touch the value [E chr-coding 289-297].
- Without it: index entries have empty values, so index scans and index counts are already keys-only in effect. The gap is the primary rows: listing ids or counting a collection copies every document. The Chromium workaround is one extra key per row, one more op per insert and delete.
- Rating: **worth-having**. A `keysOnly` flag on `Range` and a `count(range)` built on it.

**E. Range delete.** Not in kv (R1.1).
- Precedent: FoundationDB `clear_range`; Record Layer removes an index with `context.clear(subspace.range())` and calls it "a cheap operation because the index is contiguous" [E rl-store 1969, rl-evo 106]; the directory layer removes a directory the same way [E fdb-dir 585-589]; RocksDB `DeleteRange` [E rocks-db 707]; IndexedDB `clear`, `deleteIndex`, `deleteObjectStore`.
- Without it: retire the id in the catalog in one write, which is atomic for every reader and writer, then sweep the old prefix with a keys-only scan and deletes in chunks under 10,000 ops. Cost: one tombstone per key through the WAL and the SSTs, so clearing a million rows with three indexes is about four million deletes in more than 400 batches [I, arithmetic only].
- What it would take [I]: a range tombstone must be honoured by get, scan, the fold and compaction. It is the largest kv change on this list.
- Rating: **worth-having**. Id indirection makes it a cost problem, not a correctness problem.

**F. Atomic writes larger than the batch limits.** Not in kv: 10,000 ops and 8 MiB (R1.1).
- Precedent: none needs it. FoundationDB has a 10 MB and five-second limit, and Record Layer's answer is the write-only state plus many transactions [E fdb-lim, rl-evo 100]. The Firestore SDK backfills 50 documents at a time [E fs-bf].
- Without it: chunked backfill behind the `building` state; bulk load in chunks, each atomic.
- Rating: **not-needed**. The index state is needed anyway for other tabs.

**G. Snapshot reads across several calls.** kv has it: `view` takes an async body (R1.1).
- Precedent: `abstract-level`: "The main use case for explicit snapshots is retrieving data from an index" [E level 1056]; FoundationDB caps a transaction at five seconds [E fdb-lim].
- How long a view may be held is not stated in `docs/design.md`. From the code [I]: it pins memtable chunks, so writes copy shared chunks, and it holds a generation, so superseded run files stay until release (R1.1). Pagination across user actions should use cursors, as DynamoDB and Firestore do, not a held view.
- Rating: **not-needed** beyond what exists. Worth one sentence in the kv docs on the cost of a long view.

**H. Reserved keyspace and a format version checked on open.** kv has no reserved prefix for users; its own format version is in the generation manifest (`store/generation.ts:100-102`).
- Precedent: Chromium id 0 and its two version keys [E chr-coding 154-156]; TiDB's `m` prefix [E tidb-tc]; the directory layer's node subspace and version [E fdb-dir]. In each, the layer owns this, not the engine.
- Without it: the document store takes one prefix byte for itself and keeps the catalog, with format and version numbers, in an ordinary key. Other users of the same database (the Yjs and Automerge adapters) must stay out of that prefix by convention.
- Rating: **not-needed** in kv.

**I. Async bodies, or optimistic conflict detection.** Not in kv: the body is synchronous because an await would commit the IndexedDB transaction (R1.1).
- Precedent: FoundationDB transactions are async with conflict ranges and a retry loop [E fdb-api 1093-1105]; Replicache mutators are async.
- Without it: `update` is a compare-and-set, so the layer writes its own optimistic loop in a few lines (2.7).
- Rating: **not-needed**, and less so if C lands.

**J. Prefix or range statistics.** Not in kv: the manifest has per-run key ranges and sizes only (R1.1).
- Precedent: FoundationDB `get_estimated_range_size_bytes` [E fdb-api 1133]; RocksDB `GetApproximateSizes` and `kEstimateNumKeys` [E rocks-db]; Record Layer counts records to choose between an inline and an online index build [E rl-evo 98]; the Firestore SDK's planner uses collection size [E fs-qe].
- Without it: there is no planner (2.6). "Is this collection small" is a scan with `limit: n + 1`.
- Rating: **not-needed**.

**K. Merge operators or compare-and-set.** Not in kv as such; `update` gives both at the cost of a read.
- Precedent: FoundationDB atomic `add`, `compare_and_clear`, versionstamped keys [E fdb-api 968-1010]; Record Layer builds `COUNT` and `SUM` indexes on them (Overview, not quoted); RocksDB `Merge` [E rocks-db 728].
- Without it: maintained counters go through `update`. Reads there are in-memory (DIPA R1.4) and IndexedDB already serialises writers, so the operator would save little.
- Rating: **not-needed**.

**Also checked, already present.** Scan-then-join in one state: `rangeFollow` (R1.1), which is what an index query needs. Multi-key point reads in a write: `update`. Exclusive start for cursors: `key + 00`, done by the caller. A value filter pushed into the engine: `valueContains`, which the precedents do not have.

**Ordered by how much each simplifies the document store:**

1. **A, reverse scan.** Removes inverted encodings, second indexes and in-memory reversal. Must-have.
2. **B, keys on `changes`.** Turns live queries from "rerun everything" into a range test. Must-have before live queries; small.
3. **C, `tx.get` (then `tx.range`) in the `update` body.** Removes the optimistic loop for `modify` with unique indexes, and allows range-conditional writes.
4. **D, `keysOnly` and `count`.** Removes value copies from id listing, counting and the sweep.
5. **E, range delete.** Removes the sweep and its tombstones. Largest kv change; lowest urgency because ids already make drops atomic.
6. F to K: nothing to build.

---

## 7. Rejected

- **A query planner** (Mango, RxDB). It needs cost rules, in-memory filter and sort paths, and a full-scan fallback. Firestore, DynamoDB and Dexie show the index-only model is enough for app queries (2.6).
- **Inverted-byte descending keys.** Right for mixed-direction compound sorts; otherwise a workaround for a missing reverse scan (2.6, 6 A).
- **Schema-bounded fixed-width keys** (RxDB). Forces `maxLength` and numeric bounds on every indexed field (2.3).
- **A custom comparator** (ArangoDB, Chromium). kv compares bytes and its bloom filters and block prefixes depend on that.
- **A database per schema version** (Replicache, RxDB). Both rely on a server or a migration to carry data across. This store has neither.
- **Lazy index cleanup with row versions** (Chromium). DIPA 3.6 and 5.1: eager diff is cheap here.
- **Refusing old clients on every schema change** (`VersionError`). A web deploy always leaves old tabs open; declarative specs let them keep working (2.5).
- **Deriving index keys in kv or its SharedWorker.** Rejected in DIPA 5.3; not reopened.

---

## 8. Recommendation

### 8.1 The design on kv as it is today

**Keys.** One root byte owned by the document store, then fixed-width ids.

```
root 0000                                -> catalog (JSON)
root <coll:u16be> 00 <id utf8>           -> document (JSON text)
root <coll:u16be> <ix:u8> <values> <id>  -> ""          non-unique index, ix >= 1
root <coll:u16be> <ix:u8> <values>       -> <id utf8>   unique index
```

Collection id 0 is metadata, index id 0 is the rows (Chromium's reserved ids). Ids are allocated from a counter in the catalog and never reused (Chromium: "the ID space is assumed to be sufficient"). The id is the raw tail of the key. Ids are non-empty strings; the whole key must fit kv's 8 KiB. Precedent: Chromium, CockroachDB, TiDB for the shape; CockroachDB, TiDB, ArangoDB for the unique form.

**Values in keys.** Tuple subset of 2.3: tag bytes ascending for null, false, true, number, string; number is the sign-flipped big-endian double with `-0` written as `0`; string is UTF-8 with `00 -> 00 FF` and a `00` terminator; compound is concatenation. No bytes, no nested arrays, no objects. Precedent: FoundationDB tuple layer, with the zero rule of CockroachDB, KeyString and Firestore.

**Documents.** JSON text. On write: encode, parse the bytes back, derive every entry from the parsed value. The old row's entries come from its stored bytes the same way, so both sides of the diff use one function on one form. Precedent: IndexedDB's clone-then-extract.

**Index spec.** `{ on: path | path[], unique?, multi? }` by name, dot paths. `multi` expands one array-valued path into one entry per distinct element. A missing path means no entry. An object, or an array without `multi`, at an indexed path is a write error. `null` is a value. Precedent: IndexedDB key paths and flags, Dexie's compound form. Not offered: partial indexes, per-component direction, functions.

**Catalog and lifecycle.** One key holds `{format, version, nextId, collections: {name: {id, indexes: {name: {id, on, unique, multi, state}}}}, dropped: [prefix...]}`. The app passes an integer `version` with its schema.

- Open, in one `update([catalog])`: no catalog, write it. Stored `format` above the library's: throw. Declared `version` above the stored one: apply the difference. A new collection gets an id and `ready` indexes. A new index on an existing collection gets an id and `building`. A removed index, or one whose definition changed, moves its id to `dropped`; a changed one is then added as new. Equal versions with different specs: throw (RxDB `DB6`). Declared `version` below the stored one: keep the catalog, maintain everything in it, allow queries only on indexes whose stored spec equals the declared one.
- Every write is `update([catalog, ...primaryKeys, ...newUniqueKeys], body)`. If the catalog bytes differ from the cached copy, the body writes nothing and the write is retried with the new catalog. This is how an open tab starts maintaining an index another tab just added (Record Layer's store-header check). Tabs also refresh the cached catalog on `changes` events, for reads.
- Backfill: scan the rows in chunks; for each chunk `update([catalog, ...pks])`, re-read the rows inside the transaction, put this index's entries. Then flip the state to `ready`. Puts are idempotent, so two tabs doing it at once is wasteful, not wrong. A unique violation fails the build and the open (IndexedDB, MongoDB). A crash leaves `building`; the next open starts over. `open` waits for the build by default; a query on a `building` index throws.
- `clear(collection)` gives the collection new ids and moves the old prefix to `dropped`, in one catalog write. A sweeper deletes `dropped` prefixes by key scan in chunks and removes them from the list. No key is ever re-derived.

**API.**

```
get(id)  getMany(ids)
put(doc)  putMany(docs)          upsert; all in one transaction; throws over the batch limit
patch(id, partial)  modify(id, fn)
delete(id)  deleteMany(ids)  clear()
query({ index?, eq?: values[], gt|gte|lt|lte?: value, startsWith?: string,
        limit?, after?, keysOnly? })  ->  { docs | ids, next? }
count(same range)
```

`eq` fixes the first k components; the range or `startsWith` applies to component k+1; this holds for every index, single or compound. Without `index` the query walks the rows in id order, with `startsWith` and bounds applying to the id. `after` is the last key of the previous page and is exclusive. Precedent: DynamoDB `Query`, Replicache `scan`, `IDBKeyRange`.

**On today's kv, specifically.** No `reverse` (apps keep storing a negated sort value until 6 A lands; do not build inverted keys). `count` and `keysOnly` over the rows copy the documents. `modify` on a collection with unique indexes runs the optimistic loop. No live queries, or a coarse "rerun on any event". The sweep writes one tombstone per key.

### 8.2 The design once reverse scan and keyed change events exist

Same keys, same encoding, same catalog. What changes:

- `query` gains `reverse: true`, with `after` meaning "before this key". One index serves both directions.
- `subscribe(query, cb)`: each live query holds its key range; on an event, rerun only if a changed key falls in the range; deliver only if the page differs (Replicache). An event without keys invalidates everything.
- With C: `modify` becomes a single `update` whose body reads the unique keys it needs. With D: `count`, `keysOnly` and the sweep stop copying values. With E: the sweep becomes one range delete per dropped prefix.

None of these changes the stored layout, so 8.1 can ship first and nothing is rewritten later. That is the reason to refuse inverted keys now: they are the one workaround that would be baked into stored data.

### 8.3 Where two options are close

- **Parse-back versus a strict validator** for finding 1. I pick parse-back: it is one line and cannot drift. Measure it; if it shows in put latency, switch to the validator and keep the round trip as a debug assertion.
- **Old clients: keep working versus refuse.** I pick keep working, gated by `format`. It depends on specs being pure data. If index kinds ever need code that old clients lack and a format bump is not acceptable, refuse instead.
- **Open waits for backfill versus returns at once.** I pick wait by default (IndexedDB's behaviour, simplest for the app), with an option not to.
- **`dropped` sweep versus leaving garbage.** I pick the sweep. Without it a cleared collection keeps its bytes forever.

### 8.4 Left out

Planner, filters, `OR` and `IN` (run several queries); joins; aggregates other than count; collation and case folding (store a normalised field); bytes, dates and bigints as index values; auto-increment ids; document migrations (RxDB's `migrationStrategies`); partial indexes; mixed-direction compound sorts; nested-array keys; revisions and replication.

### 8.5 Evidence that would change this

- A bench where the parse-back is a visible share of put time on realistic documents: use the validator (8.3).
- Catalogs that grow large (hundreds of collections) so that reading one JSON key per write shows up: split the catalog per collection, as Chromium does, and read only the keys a write touches.
- A real need for sorts like `a asc, b desc`: add a per-component `desc` flag using inverted bytes (CockroachDB, KeyString). It is additive.
- Clearing or dropping large collections turns out to be common and the tombstone load hurts ingest: build range delete (6 E) earlier.
- Apps that need range-conditional writes ("insert unless a row in this range exists"): build `tx.range` (6 C).
- A product need for binary or date index values: that pushes the document encoding toward a typed binary format and reopens 2.4.
- Evidence that old tabs writing through a newer catalog cause bad data (for example documents that violate the new app's assumptions): move to refusing old clients.

---

## 9. What I did not verify

- Nothing was run. No benchmark, no prototype. The cost of the parse-back, of the catalog read per write, and of the sweep are unmeasured. "More than 400 batches" for a million-row clear is arithmetic.
- That a synchronous `tx.get` or `tx.range` in the `update` body is a small change is my reading of `db.ts:737-784`. I did not check the wasm scan path or `valueContains` for synchronous use.
- That exposing ops on `changes` is small: I read the bus message and the two emit sites. I did not read the `sync` catch-up path to see what it knows about keys.
- How long a `view` may be held: inferred from the pin and the reference count, not from a stated limit or a test.
- Large sources were searched, not read whole: `key_string.cpp` (type codes, string escape, zero, inversion, discriminators only), `FDBRecordStore.java` (version check, clears, rebuild threshold), `encoding.go`, the IndexedDB spec, `indexeddb_index_manager.ts`.
- MongoDB: that a single index serves both directions by backward traversal is not sourced here; the multikey rules for compound indexes and unique-index treatment of missing fields were not read. `RecordId` layout in KeyString was seen (`appendRecordId`) but not read.
- CockroachDB: `CPut` on unique entries is from DIPA 3.1, not re-read. Partial indexes not re-read.
- Record Layer: the online indexer's range sets and resume logic, and its `COUNT` and `SUM` atomic-mutation indexes, were not read; the latter is cited from memory of the Overview and should be checked before quoting.
- Firestore: server index build states were not read. The client SDK is the source for everything said about index encoding and backfill; the server may differ.
- Replicache: how indexes are rebuilt when a client group forks was not read. Its `subscribe` matching was read from the types and class shape, not the diff code.
- RxDB: `event-reduce.ts`, the migration plugin's behaviour with two tabs on different schema versions, and the storage instance naming beyond the internal store key were not read.
- Dexie: the `versionchange` path was read; I did not test what an old Dexie tab does with tables it does not declare after reopening at a newer version.
- Chromium: how `clear`, `deleteIndex` and `deleteObjectStore` remove key ranges on LevelDB was not read. The coding scheme document may lag the code; Chromium has been moving IndexedDB toward a SQLite backing store and I did not check the state of that.
- IndexedDB second edition revision history was not fetched; only the third edition's list in the current draft.
- Why browser stores use JSON or structured clone and not a binary codec: no primary source found; the reason given is inference.
- "Which features users then ask for": no issue trackers were read.
- Not read at all: Triplit (the fetch of its README returned nothing), TinyBase (page fetched, not read), Fireproof, LokiJS, CouchDB's `_changes`, WiredTiger, DynamoDB beyond the `Query` page. PouchDB's IndexedDB adapter was not read; only `pouchdb-collate` and `pouchdb-find`.

---

## 10. Sources

Repo, checkout at `10f7f99`: `AGENTS.md`; `packages/kv/src/db.ts`, `check.ts`, `view.ts`, `changes.ts`, `bytes.ts`, `store/cursor.ts`, `store/generation.ts`, `store/levels.ts`; `packages/collections/src/table.ts`, `codec.ts`, `typed.ts`, `entries.ts`, `database.ts`; `docs/design.md`; `docs/research/derived-index-prior-art.md`.

External, fetched 2026-11-09, raw unless marked:

- `fdb-tuple` https://raw.githubusercontent.com/apple/foundationdb/main/design/tuple.md
- `fdb-guide` https://raw.githubusercontent.com/apple/foundationdb/main/documentation/sphinx/source/developer-guide.rst ; `fdb-api` same directory `api-python.rst` ; `fdb-lim` same directory `known-limitations.rst`
- `fdb-dir` https://raw.githubusercontent.com/apple/foundationdb/main/bindings/python/fdb/directory_impl.py ; `fdb-sub` same directory `subspace_impl.py`
- `rl-evo` https://raw.githubusercontent.com/FoundationDB/fdb-record-layer/main/docs/sphinx/source/SchemaEvolution.md ; `rl-build` same directory `IndexBuilding.md`
- `rl-state` https://raw.githubusercontent.com/FoundationDB/fdb-record-layer/main/fdb-record-layer-core/src/main/java/com/apple/foundationdb/record/IndexState.java ; `rl-store` same tree `provider/foundationdb/FDBRecordStore.java` ; `rl-sim` same tree `provider/foundationdb/indexes/StandardIndexMaintainer.java`
- `crdb-enc-md` https://raw.githubusercontent.com/cockroachdb/cockroach/master/docs/tech-notes/encoding.md ; `crdb-enc` https://raw.githubusercontent.com/cockroachdb/cockroach/master/pkg/util/encoding/encoding.go ; `crdb-float` same directory `float.go`
- `tidb-tc` https://raw.githubusercontent.com/pingcap/tidb/master/pkg/tablecodec/tablecodec.go ; also read `pkg/util/codec/bytes.go` and `codec.go`
- `ks` https://raw.githubusercontent.com/mongodb/mongo/master/src/mongo/db/storage/key_string/key_string.cpp
- `mongo-order` https://www.mongodb.com/docs/manual/reference/bson-type-comparison-order/ (HTML, stripped) ; `mongo-build` https://www.mongodb.com/docs/manual/core/index-creation/ (HTML, stripped)
- `arango-key` https://raw.githubusercontent.com/arangodb/arangodb/devel/arangod/RocksDBEngine/RocksDBKey.cpp , `RocksDBKey.h` , `RocksDBComparator.h`
- `chr-coding` https://chromium.googlesource.com/chromium/src/+/main/content/browser/indexed_db/docs/leveldb_coding_scheme.md ; also `content/browser/indexed_db/instance/index_writer.cc`
- `idb-spec` https://raw.githubusercontent.com/w3c/IndexedDB/main/index.bs (line numbers are of this file)
- `fs-ivw` https://raw.githubusercontent.com/firebase/firebase-js-sdk/main/packages/firestore/src/index/firestore_index_value_writer.ts ; also `index/ordered_code_writer.ts` ; `fs-fi` `model/field_index.ts` ; `fs-bf` `local/index_backfiller.ts` ; `fs-qe` `local/query_engine.ts` ; `local/indexeddb_index_manager.ts`
- `fs-types` https://firebase.google.com/docs/firestore/manage-data/data-types (HTML, stripped) ; `fs-idx` https://firebase.google.com/docs/firestore/query-data/index-overview (HTML, stripped)
- `ddb-query` https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Query.html (HTML, stripped)
- `dx-open` https://raw.githubusercontent.com/dexie/Dexie.js/master/src/classes/dexie/dexie-open.ts ; `dx-dexie` same directory `dexie.ts` ; `dx-obs` `src/live-query/observability-middleware.ts` ; `dx-bc` `src/live-query/enable-broadcast.ts` ; `dx-lq` `src/live-query/live-query.ts` ; `dx-table` `src/public/types/table.d.ts` ; `dx-where` `src/public/types/where-clause.d.ts`
- `rx-ci` https://raw.githubusercontent.com/pubkey/rxdb/master/src/custom-index.ts ; `rx-qp` `src/query-planner.ts` ; `rx-db` `src/rx-database.ts` and `src/rx-database-internal-store.ts`
- `rc-idx` https://raw.githubusercontent.com/rocicorp/mono/main/packages/replicache/src/db/index.ts ; `rc-defs` `src/index-defs.ts` ; `rc-scan` `src/scan-options.ts` ; `rc-sub` `src/subscriptions.ts` ; `rc-name` `src/make-idb-name.ts` ; `rc-clients` `src/persist/clients.ts`
- `pc` https://raw.githubusercontent.com/pouchdb/pouchdb/master/packages/node_modules/pouchdb-collate/src/index.js ; `pf` same tree `pouchdb-find/src/adapters/local/find/index.js` and `query-planner.js`
- `bytewise` https://raw.githubusercontent.com/deanlandolt/bytewise/master/README.md ; `charwise` https://raw.githubusercontent.com/dominictarr/charwise/master/README.md ; `level` https://raw.githubusercontent.com/Level/abstract-level/main/README.md
- `couch-coll` https://raw.githubusercontent.com/apache/couchdb/main/src/docs/src/ddocs/views/collation.rst
- `rocks-db` https://raw.githubusercontent.com/facebook/rocksdb/main/include/rocksdb/db.h
