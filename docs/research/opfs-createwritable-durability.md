# OPFS durability across browser kills and OS crashes

Read 2026-11-09 and 2026-11-10. Engine source is each project's main branch at these commits:
- Chromium `7eaf21d` (2026-11-09). Its `DEPS` pins LevelDB `bb74ef7`, which is also upstream LevelDB's head (2026-10-08).
- WebKit `1dcebf5` (2026-11-09).
- Firefox `47f2a88` (2026-11-09).
- libc++ (llvm-project) `55122cb`, for `std::filesystem::copy_file`.

Specs:
- File System Standard, "Last Updated 19 October 2026", snapshot `d76d345`.
- HTML Standard, "Last Updated 9 November 2026".

Shipped browsers can lag main. Where the difference matters and is known, the note says so. The repo's own measurements were on Chrome 156, Safari 26.6.2 and Firefox 157.

Every claim carries one label:
- **source** means read in the code or spec. The deciding line is quoted.
- **reported** means a bug report or the repo's own measurements say so.
- **inferred** means reasoning from the sources named on that line.

## 1. The question

The SharedWorker publishes each manifest with `createWritable()` + `write()` + `close()`, and the ingest-queue design adds per-tab logs written through a SyncAccessHandle. After a browser kill or an OS crash, which of `createWritable`+`close`, `SyncAccessHandle.flush()`, file and directory creates, and `removeEntry` can the engine trust, in Chrome, Safari and Firefox?

## 2. The answer

"Kill" means the browser process dies (`kill -9`, CDP `Browser.crash`) and the OS keeps its page cache. "OS crash" means the OS dies or the power is cut.

| Operation | Chrome | Safari | Firefox |
|---|---|---|---|
| `createWritable` + `close` | **Kill.** Kept once `close()` resolves. The swap file replaces the target in one LevelDB batch that is not synced (source). Exception. In the first session after an earlier crash, the batch can be forgotten one launch later (§3.2, source + reported). A kill during `close()` leaves `<name>.crswap` behind (reported). **OS crash.** Can be lost. Neither the data nor the batch is synced (source). | **Kill.** Before WebKit `325091@main` (2026-10-29), `close()` resolves before the commit runs, so a resolved `close()` can still be lost (source). The commit truncates the target and copies into it, so a kill during the copy leaves the target empty or partial (source + inferred). **OS crash.** Nothing on this path calls fsync. Unproven (inferred). | **Kill.** Kept once `close()` resolves. The reply is sent after one SQLite transaction points the entry at the new data file (source). A kill inside that call can leave the entry pointing at a deleted data file (inferred). **OS crash.** The entry swap is synced. The new data is not fsynced (source + reported). |
| SyncAccessHandle `write` + `flush` | **Kill.** The bytes are kept once `write()` returns, with or without `flush()` (inferred). The name is a `Paths` record like any create (row 3). **OS crash.** `flush()` is `fdatasync` on Linux and `F_BARRIERFSYNC` on macOS, on the data only. The name is never synced (source). | **Kill.** Kept once `write()` returns (inferred). **OS crash.** `flush()` is a plain `fsync()` of the data file. The directory entry is never fsynced (source + inferred). | **Kill.** Kept (inferred). **OS crash.** `flush()` is `fsync()` of the data file (source). The entry was committed to synced SQLite at create (source + reported). |
| Create file (`getFileHandle({create:true})`) | **Kill.** Kept once resolved, with the same exception as row 1 (source + reported). **OS crash.** Can be lost. It is an unsynced LevelDB record (source). | **Kill.** Kept. It is a real `open()` with create (source + inferred). **OS crash.** Not fsynced. Unproven (inferred). | **Kill.** Kept once resolved. It is one SQLite transaction (source). **OS crash.** Kept. The commit syncs the journal, the directory and the database (reported). |
| Create directory (`getDirectoryHandle({create:true})`) | Same as create file. A lost directory record also loses everything under it (reported). | Same as create file. It is a real `mkdir` (source). | Same as create file. It is one transaction (source). |
| `removeEntry` | **Kill.** Kept once resolved, with the same exception as row 1. If the record is lost, the name comes back but its data file was already deleted (source + reported). Losses are not always the newest operations. A later remove can survive while earlier creates are lost (§3.2, inferred). **OS crash.** Can be lost (source). | **Kill.** Kept. It is `unlink` or a recursive remove, and a recursive remove is not atomic (source). **OS crash.** Unproven (inferred). | **Kill.** Kept once resolved. The data files are deleted before the entry rows, so a kill in between leaves an entry with no data (source). **OS crash.** The entry delete is synced (reported). Metadata losses are always a run of the newest transactions (inferred). |

Chrome's exception in brief. A kill can tear the last record of Chrome's `Paths` log. The next launch appends after the torn record. One launch later, Chrome drops the rest of that 32 KiB log block. So the operations that get lost are the ones made *after* the crash, in the first session that follows it. They are not the ones made just before the kill.

## 3. Mechanisms

### 3.1 What the spec promises

- `createWritable` + `close`. The close algorithm runs "Set stream's [[file]]'s binary data to stream's [[buffer]]", followed by the note "It is expected that this atomically updates the contents of the file on disk being written to." Atomicity is a non-normative expectation, and nothing is said about durability. (source) [fs §2.5][fs-close]
- Until `close()`, nothing reaches the target. The spec says "No changes are written to the actual file on disk until the stream has been closed." (source) [fs write()][fs-write]
- `flush()` is defined as "Attempt to transfer all cached modifications of the file's content to the file system's underlying storage device." The note adds that it "can be a no-op on some file systems". (source) [fs flush()][fs-flush]
- The SyncAccessHandle `close()` note says it "does not guarantee that all file modifications will be immediately reflected in the underlying storage device. Call the flush() method first if you require this guarantee." (source) [fs close()][fs-sahclose]
- `flush()` covers file content, not metadata, and this is deliberate. The author of the PR that wrote it said that "'file content' is intentional here because it gives user agents the freedom to not flush file metadata if they so choose." (reported) [whatwg/fs#85][fs-85], fixing [whatwg/fs#71][fs-71]
- `getFileHandle`, `getDirectoryHandle` and `removeEntry` contain no durability or crash wording. The two creates say "If creating child in the underlying file system throws an exception, reject result with that exception and abort these steps." `removeEntry` says the same with "removing". (source) [getFileHandle][fs-getfile], [getDirectoryHandle][fs-getdir], [removeEntry][fs-remove]
- The only atomicity note on `removeEntry` is "If recursive is true, the removal can fail non-atomically." (source) [removeEntry][fs-remove]
- The words "durab", "crash" and "fsync" appear nowhere in the spec. "Persist" appears once, in "While user agents will typically implement this by persisting the contents of a bucket file system to disk". (source) [fs §3][fs-bucket] (searched in the fetched HTML)

So the spec promises nothing about crashes for any of the five operations. `flush()` asks for durable file content only.

### 3.2 Chromium

**Where a name lives.**
- OPFS names live in a LevelDB named `Paths`, one per file system (`kDirectoryDatabaseName[] = FILE_PATH_LITERAL("Paths")`). (source) [sandbox_directory_database.cc L72][c-sdd-name]
- On Chrome 156 the repo found it at `<profile>/Default/File System/<n>/t/Paths`. (reported) repo, `docs/research/chrome-opfs-paths-leveldb-torn-tail.md` on `feat/kv-per-tab-logs`
- File data lives in numbered files (`NN/NNNNNNNN`). The numbers come from a counter kept in the same LevelDB. (source) [`GenerateNewLocalPath`][c-ofu-newpath]

**No metadata write is synced.**
- Every create, remove, move and counter bump is `db_->Write(leveldb::WriteOptions(), &batch)` with the default options. (source) [sandbox_directory_database.cc L559-L680][c-sdd-write]
- The default is `bool sync = false;`. (source) [options.h][l-opts]
- LevelDB's comment on that default reads "If this flag is false, and the machine crashes, some recent writes may be lost. Note that if it is just the process that crashes (i.e., the machine does not reboot), no writes will be lost even if sync==false." (source) [options.h L176-L179][l-opts]
- So against an OS crash, every OPFS create, remove and `close()` in Chrome can be lost. inferred from the lines above.

**Why a process kill still tears the log.**
- LevelDB's promise assumes each log record reaches the OS whole. LevelDB's writer emits a record as two appends, `dest_->Append(Slice(buf, kHeaderSize))` and then `dest_->Append(Slice(ptr, length))`. (source) [log_writer.cc L99-L101][l-writer]
- Chromium's `Append` writes straight to the file, `file_.WriteAtCurrentPosAndCheck(...)`. Its `Flush()` does nothing, because "base::File doesn't do buffered I/O ... so nothing to flush." (source) [env_chromium.cc L354-L373][c-env-append]
- So each record is two `write()` calls. A kill between them leaves a 7-byte header with no payload. inferred from the two lines above.
- The repo saw exactly that, "a 7-byte record header with no payload", in about one crash in ten (21 of 180). (reported) repo, `chrome-opfs-paths-leveldb-torn-tail.md`

**Why the torn tail later costs a block.**
- At open, the reader treats a torn tail as the end of the log. Its comment reads "If the end of the file has been reached without reading |length| bytes of payload, assume the writer died in the middle of writing the record. Don't report a corruption." (source) [log_reader.cc L205-L234][l-reader]
- Chromium turns log reuse on for desktop with `reuse_logs = !base::SysInfo::IsLowEndDeviceOrPartialLowEndModeEnabled();`. The comment above it notes that reuse caused "an unacceptably high leveldb corruption rate" on ChromeOS, where it stays off. (source) [env_chromium.cc L476-L501][c-env-opts]
- `SandboxDirectoryDatabase::Init` takes these defaults through `leveldb_env::OpenDB(options, path, &db_)`. (source) [sandbox_directory_database.cc L718-L760][c-sdd-init]
- With reuse on, recovery reopens the last log for append at its current size, torn header included (`log_ = new log::Writer(logfile_, lfile_size);`). (source) [db_impl.cc L471-L480][l-reuse]
- At the next open, the orphan header's length now spans the new records. The checksum fails, and the reader drops the rest of the block ("Drop the rest of the buffer since "length" itself may have been corrupted"). (source) [log_reader.cc L245-L256][l-reader]
- With `paranoid_checks` off, the drop is skipped silently and the open succeeds. (source) [db_impl.cc L413-L422][l-paranoid] (Chromium's options never set it, per a grep of `env_chromium.cc`)
- Upstream LevelDB has this exact case open as [google/leveldb#1287][l-1287] (2025-11-02), titled "reuse_logs can reuse a log with an incomplete record". The proposed fix, [#1336][l-1336] (2026-06-11), "Do not reuse logs that end with an incomplete record", is unmerged. reported
- Chromium's pinned `bb74ef7` still reuses without that check. (source) [DEPS L2547-L2548][c-deps], [db_impl.cc L472][l-reuse]

**What is lost.**
- The loss runs from the orphan header to the end of its 32 KiB block, plus the rest of any record fragmented across that boundary. Records in later blocks survive. inferred from [log_reader.cc][l-reader]
- So losses are not always the newest operations. Early operations of the session after a crash can be lost while later ones are kept. inferred
- The repo's pad depends on exactly this. Writing more than 32 KiB of throwaway `Paths` records first moved the real records past the block, and nothing was lost (0 of 16 torn logs). (reported) repo, same note

**How `createWritable` + `close` maps onto this.**
- The swap file is a sibling named `<name>.crswap`, in the same file system (`url().CreateSibling(*opt_swap_name)`). (source) [file_system_access_file_handle_impl.cc L729-L762][c-swap]
- `close()` starts `FileSystemAccessSafeMoveHelper`. (source) [file_system_access_file_writer_impl.cc L267-L294][c-writer-close]
- For OPFS (`kFileSystemTypeTemporary`), `RequireAfterWriteChecks()` and `RequireQuarantine()` both return false. No Safe Browsing check and no quarantine run. The move is then `FileSystemOperationRunner::Move`. (source) [file_system_access_safe_move_helper.cc L193-L238, L313-L318][c-safemove]
- Nothing flushes the swap file first. Writes use `url.mount_option().flush_policy()`, and the default is `FlushPolicy::NO_FLUSH_ON_COMPLETION`. (source) [file_system_operation_runner.cc L293-L294][c-runner], [file_system_mount_option.h L31-L32][c-mountopt]
- No code in the files read gives OPFS URLs another mount option. inferred
- A move that overwrites is "transaction: Remove source entry. Point target entry to source entry's backing file. Delete target entry's old backing file". This is one `OverwritingMoveFile` batch followed by an unlink. (source) [obfuscated_file_util.cc L640-L676][c-ofu-move]
- The rename is therefore atomic at the LevelDB level. One batch is one log record (`log_->AddRecord(WriteBatchInternal::Contents(write_batch))`). inferred from [db_impl.cc L1236][l-sync]
- If that batch falls in a dropped block, the target's entry still points at its old data file, which was already unlinked. The first lookup then logs "Lost a backing file." and removes the entry, and `<name>.crswap` reappears holding the new bytes. inferred from [L667-L669][c-ofu-move] and [L1157-L1162][c-ofu-lost]. Not observed by the repo.
- `removeEntry` writes `RemoveFileInfo` and then unlinks the data file. (source) [obfuscated_file_util.cc L782-L823][c-ofu-delete]
- If that record is lost, the name comes back with no data. The repo saw "entries it removed come back". inferred from the line above; (reported) repo

**SyncAccessHandle `flush()`.**
- The renderer calls `backing_file_.Flush()`. (source) [file_system_access_regular_file_delegate.cc L127-L130][c-sah]
- That is `fdatasync` on Linux and `fcntl(F_BARRIERFSYNC)` on macOS, with `fsync` as the fallback. The comment says "The default behavior used to be `F_FULLFSYNC`", and that on macOS `fsync()` "may return before the device actually writes the data to the medium". (source) [file_posix.cc L674-L708][c-flush]
- In 2024, whatwg/fs#156 still described Chromium as using `F_FULLFSYNC`. That has since changed. (reported) [whatwg/fs#156][fs-156]; (source) [file_posix.cc][c-flush]
- `flush()` writes no `Paths` record and syncs none. inferred from the above.
- An strace on Linux counted 0 fsyncs per create, write, close and delete cycle in Chrome 152, and 1.01 per `flush()`. (reported) [Mozilla bug 2072928][g-2072928]

**A path that was not observed.**
- If the `Paths` database fails to open with corruption, `Init` repairs it. If repair fails, it falls through to "Clearing SandboxDirectoryDatabase", which deletes the database and with it every name. (source) [sandbox_directory_database.cc L735-L756][c-sdd-init]
- #1287 says reuse applies to the MANIFEST too. reported
- A torn MANIFEST could reach this path. inferred. The repo has not seen it.

### 3.3 WebKit

**Names are real directory entries. There is no metadata database.**
- A handle's path is `FileSystem::pathByAppendingComponent(m_path, name)`. (source) [FileSystemStorageHandle.cpp L150-L160][w-remove]
- Create is `FileSystem::openFile(path, ReadWrite)` for a file and `FileSystem::makeAllDirectories(path)` for a directory. (source) [FileSystemStorageHandle.cpp L48-L60][w-handle-create]
- `removeEntry` is `deleteFile`, `deleteEmptyDirectory` or `deleteNonEmptyDirectory`. (source) [FileSystemStorageHandle.cpp L150-L190][w-remove]
- `deleteNonEmptyDirectory` is `std::filesystem::remove_all`. (source) [FileSystem.cpp L641-L646][w-copy]
- Once a call returns, a browser kill keeps it, because the OS holds it. inferred
- Not found. What APFS keeps after a power loss, for unsynced creates and unlinks, and in what order.

**`createWritable` + `close`.**
- `createWritable` makes `FileSystem::createTemporaryFile("FileSystemWritableStream"_s)`, outside the OPFS directory. (source) [FileSystemStorageHandle.cpp L262-L295][w-writable]
- A completed `close` runs `FileSystem::copyFile(m_path, activeWritableFile.path)`. That is a copy, not a rename. (source) [FileSystemStorageHandle.cpp L297-L321][w-writable]
- `copyFile` is `std::filesystem::copy_file(..., copy_options::overwrite_existing, ec)`. (source) [FileSystem.cpp L623-L631][w-copy]
- In libc++ that opens the existing target, calls `posix_ftruncate(to_fd, 0, m_ec)`, and then copies the data. (source) [libc++ operations.cpp L429-L455][llvm-copy]
- Apple's shipped libc++ was not read. Assuming it matches, the commit is not atomic, and a kill during the copy leaves the target empty or partial. That contradicts the spec's "atomically" note. inferred
- No fsync is called anywhere on this path. (source) the functions above
- Until recently the promise also settled early. WebKit bug [329088][w-329088], "FileSystemWritableFileStream.close() resolves before the file is committed", was fixed on 2026-10-29 in [`b5fe7b3`][w-fix] (`325091@main`). (source) commit message
- The commit message says "`FileSystemWritableFileStreamSink::close()` resolved its promise as soon as it sent CloseWritable to the network process, and the reply was dropped. The written data only replaces the file when the network process handles that message, so a close() that had resolved did not guarantee that the file had its new contents, and a failure to commit them was never reported."
- Which Safari release first ships this fix is not established.

**SyncAccessHandle `flush()`.**
- `flush()` calls `m_file.flush()`. (source) [FileSystemSyncAccessHandle.cpp L97-L103][w-sah]
- That is `return m_handle && !fsync(*m_handle);`. It is not `F_FULLFSYNC`. (source) [FileHandlePOSIX.cpp L73-L76][w-flush]
- No code read fsyncs the parent directory. inferred

### 3.4 Gecko

**Names live in SQLite.**
- `GetStorageConnection` opens the database with `OpenDatabaseWithFileURL(..., CONNECTION_DEFAULT)`. It sets only `foreign_keys` (and `page_size` when encrypted), and no `journal_mode`. (source) [FileSystemDataManager.cpp L118-L156][g-conn]
- mozStorage's default on desktop is `PRAGMA synchronous = NORMAL;`, with the comment "Normal is the suggested value for WAL journals". (source) [mozStorageConnection.cpp L1474-L1482][g-sync]
- With no `journal_mode` set, the database uses SQLite's default rollback journal (DELETE). inferred
- A Linux strace agrees. Each transaction on `metadata.sqlite` costs 3 fsyncs (the journal, the `fs` directory, the database), and "The data file itself is never synced except by flush()". (reported) [bug 2072928][g-2072928]. That report marks its own mapping of transactions to code as unconfirmed.
- SQLite says "Transactions are durable across application crashes regardless of the synchronous setting or journal mode." (source) [SQLite pragma synchronous][sq-sync]
- For DELETE mode with NORMAL, it adds that "There is a very small (though non-zero) chance that a power failure at just the wrong time could corrupt the database ... on an older filesystem." (source) [same][sq-sync]
- `GetOrCreateFile` and `GetOrCreateDirectory` are each one explicit transaction. (source) [Version001.cpp L654-L727][g-create], [L578-L646][g-mkdir]

**`createWritable` + `close`.**
- Writes go to a separate temporary data file. (source) [FileSystemDataManager.cpp L513-L579][g-unlock] (`LockShared` and `UnlockShared` take a temporary file id)
- On `close()`, the parent runs `UnlockShared(...)`, which runs `MergeFileId`, and only then calls `aResolver(void_t())`. (source) [FileSystemWritableFileStreamParent.cpp L37-L80][g-close]
- `MergeFileId` repoints the entry with `INSERT INTO MainFiles ... ON CONFLICT (handle) DO UPDATE SET fileId = excluded.fileId` inside one transaction. Before the commit, it deletes the old main file's data (`mFileManager->RemoveFile(aCleanable)`). (source) [Version002.cpp L773-L888][g-merge]
- So the swap is atomic in SQLite. A kill between the delete and the commit rolls the entry back to a data file that no longer exists. inferred
- `UnlockShared` drops its errors (`QM_TRY(..., QM_VOID)`) and the reply is unconditional. So a failed merge still resolves `close()`. inferred from [g-unlock] and [g-close]
- No flush runs on the temporary file before the merge. A grep of `FileSystemWritableFileStream.cpp` and its parent finds no `Flush`. inferred

**`removeEntry`.**
- It calls `mFileManager->RemoveFiles(diskItems, failedRemovals)` before `DeleteEntry(mConnection, entryId)`. (source) [Version001.cpp L871-L931][g-remove]

**SyncAccessHandle `flush()`.**
- `flush()` calls `mStream->OutputStream()->Flush()`. (source) [FileSystemSyncAccessHandle.cpp L443-L470][g-sah]
- The stream is `FileQuotaStreamWithWrite<nsFileRandomAccessStream>`. (source) [FileStreams.h L122-L123][g-streams]
- Its flush is `PR_Sync(mFD)`. (source) [nsFileStreams.cpp L233-L242][g-nsflush]
- `PR_Sync` is `rv = fsync(fd->secret->md.osfd);`. It is not `F_FULLFSYNC` on macOS. (source) [ptio.c L1383-L1396][g-ptio]

**Ordering.** Metadata changes are serial SQLite transactions. A crash rolls back at most the newest ones, and never leaves a hole in the middle. inferred from SQLite's semantics above. Data-file creates and deletes sit outside those transactions, so narrow windows can leave orphan data files or entries without data. inferred from [g-merge] and [g-remove]

### 3.5 Can a SharedWorker start a dedicated WebWorker?

- Spec. Yes, `[Exposed=(Window,DedicatedWorker,SharedWorker)] interface Worker`. (source) [HTML §10.2.6.3][html-worker]
- Chrome. No.
  - The interface is `Exposed=(Window,DedicatedWorker)`. (source) [worker.idl L30-L34][c-worker-idl]
  - The 2018 intent said "Either a dedicated worker or a shared worker can be the parent". (reported) [blink-dev intent][cr-intent]
  - The landed change exposed `Worker` only to dedicated WebWorkers ("exposes the Worker() constructor to dedicated workers"). (source) [304237d][cr-nested-1], [72c2093][cr-nested-2]
  - No later change to `worker.idl` adds SharedWorker. (source) the file's commit history on GitHub
- Safari. Yes in current WebKit; the first Safari release with it is not established.
  - Main has `Exposed=(Window,DedicatedWorker,SharedWorker), ExposedEnabledBySetting=SharedWorker|WorkerInSharedWorkerEnabled`. (source) [Worker.idl L28-L31][w-worker-idl]
  - The setting is `status: stable`, `defaultValue: true`. (source) [UnifiedWebPreferences.yaml L7841-L7847][w-pref]
  - It was added on 2026-05-03 in [`3434516`][w-nested-1] and marked stable on 2026-07-14 in [`29910bc`][w-nested-2]. source
- Firefox. Yes, `[Exposed=(Window,DedicatedWorker,SharedWorker)] interface Worker`. (source) [Worker.webidl L14-L15][g-worker-idl]
  - Since which version is not established.
  - Whether `createSyncAccessHandle` works in a dedicated WebWorker nested in a SharedWorker was not probed. The IDL says yes, because the nested context is a `DedicatedWorkerGlobalScope`. inferred
- The grounding note's line "A SharedWorker cannot spawn workers" holds only for Chrome. It cites no probe of its own. (source) `design/ingest-queue/GROUNDING.md` on `probe/ingest-queue`, and `architecture/wal-opfs/00-grounding.md` on `feat/kv-per-tab-logs`

## 4. Does this explain the repo's symptom?

The symptom is not "files created shortly before a kill are gone". The repo's own evidence shows that files created *after* the kill, in the relaunched session, are gone one launch later.

- `kill-chrome.ts` on `feat/kv-per-tab-logs` has the probe `session-after-browser-kill`. It writes `s-before.bin`, kills Chrome, then relaunches. In the new session it creates `s-after.bin` and removes `s-before.bin`. It closes Chrome gracefully and checks at the next launch, reporting `created after the kill: kept|LOST` and `removed after the kill: BACK|stays removed`. (reported) repo
- The kill loop saw this as recovery failing with `CorruptDatabaseError: no manifest`. That happened in 2 of 40 `kill-browser,browser-crash` iterations, and in 0 of 60 after the pad. (reported) repo, `docs/verification.md` on `feat/kv-per-tab-logs`
- The standalone repro kills Chrome 0.5 to 3 s into a churn, creates 20 markers in the next session, and lists them in the session after. Markers were lost in 5 of 45 crashes, which were exactly the 5 that tore the log. With the pad, 0 of 135 lost markers, 16 of them torn. (reported) repo, `opfs-loss-repro.ts` and `chrome-opfs-paths-leveldb-torn-tail.md`

The grounding note's "cause unknown" dates from `ed6293a`. PR #97's head `784c0c4` diagnosed it, but the fix (`packages/kv/src/opfs/root.ts`) was only on that branch when this note was written. The change that adds this note ports the pad to `main`. (source) `git ls-tree main packages/kv/src/opfs/`

**Most likely mechanism.** It is the torn `Paths` log plus log reuse described in §3.2. Confidence is high, for four reasons:
- Each step is in source. Chromium writes a record in two parts, reuse is on for desktop, the reader silently ends at a torn tail, the reuse appends after it, and a checksum failure drops the rest of the block.
- Upstream LevelDB describes the same bug.
- The repo's byte-level reader found the orphan header holding the lost names.
- The pad, which only moves records past one block, removes the loss.

Only a process kill is needed (inferred). Nothing in it requires power loss.

**What would confirm it further.** `--enable-low-end-device-mode` makes `IsLowEndDevice()` return true, which sets `reuse_logs = false` on desktop. (source) [sys_info.cc L76-L83][c-lowend], [env_chromium.cc L495][c-env-opts]. Under that switch, torn tails should still occur and nothing should be lost. A Chromium build with google/leveldb#1336 applied should behave the same.

**Files created before the kill.** No source path was found that loses an acked create, close or remove of the killed session under a process kill, other than the one record in flight. inferred. No probe checks this directly (§7).

## 5. The owner's guess, "once a file is flushed, it will not be lost"

- **Chrome. False.** `flush()` makes the bytes durable, but not the name.
  - After a kill, a file created and flushed in the session that followed an earlier crash can lose its name one launch later. Its data file stays on disk as an orphan. source §3.2. The repo saw whole log segments written through SyncAccessHandles vanish. reported
  - Against an OS crash, the name is never synced. source
  - On macOS, `flush()` is `F_BARRIERFSYNC`, not `F_FULLFSYNC`. source. Whether that reaches stable media is not established here.
- **Safari.** True under a process kill (inferred). Unproven under an OS crash. The data is `fsync`ed, the directory entry is never fsynced, and `fsync` on macOS can return before the device writes. source §3.3
- **Firefox.** True under a process kill (inferred from source and SQLite's statement). Under an OS crash, the data is `fsync`ed (source) and the entry was committed with a synced journal (reported), so it holds, subject to the same macOS `fsync` caveat. inferred. Not tested.

The counterpart for `createWritable` + `close`:
- Chrome. Kept across a kill of the same session, except in the first session after an earlier crash. Never synced.
- Safari. Shipped versions without `325091@main` do not keep even a resolved `close()` across a kill, and the copy can tear.
- Firefox. Kept across a kill once resolved. The data is not fsynced.

## 6. Implications for the design (options only)

**Can a manifest written by `createWritable` + `close` be trusted after a browser kill?**
- Chrome. Manifests acked before the kill, yes. Manifests written in the first session after a crash, not unless that context first writes more than 32 KiB of throwaway `Paths` records (the #97 pad). reported + source
- Safari. Not in shipped builds without `325091@main` (source). A kill during the commit can also tear the manifest (inferred). Manifest checksums and an older fallback manifest cover this.
- Firefox. Yes. inferred

**Would a manifest written and flushed through a SyncAccessHandle in a dedicated WebWorker be trusted?**
- Chrome. Not more than today against a kill. Its name is the same kind of `Paths` record, and `flush()` adds no metadata sync. source. It would gain only data durability against an OS crash.
  - Chrome cannot start a dedicated WebWorker from the SharedWorker (source §3.5), so a tab's dedicated WebWorker would have to write it.
- Safari. It avoids the early resolve and the truncate-and-copy (inferred). The name still is not fsynced.
- Firefox. No gain against a kill.

**Can a delete outlive an older create?**
- Chrome. Yes, after a kill, in the session following an earlier crash. Creates in the dropped block are lost while a remove in a later block survives. inferred from §3.2. This is the precondition of defect D1 of the ingest-queue design (PR #109): manifests dropped and a later log-directory removal kept. Under an OS crash, ordering is not established.
- Firefox. Not for metadata. Losses are always the newest transactions. inferred
- Safari. Not under a process kill. Under an OS crash, not established.

**Options the evidence supports:**
1. Port the pad from `784c0c4` (done for `main` with this note) to every context that creates or removes OPFS entries, before its first such call. It covers this one Chrome mechanism, and only for code that pads first.
2. The D1 root fix, a durable record of removed logs. In Chrome, a record that is a new file is itself a `Paths` create and can fall in the dropped block. Bytes appended through a SyncAccessHandle to a file created in an earlier session write no `Paths` record. inferred, untested
3. Reclaim only logs whose covering manifest was written before the current browser session began, so no in-session drop can uncover them. inferred. This needs a way to detect a new browser session.
4. Keep recovery's refusal (`CorruptDatabaseError`) as the backstop for whatever the above misses.

## 7. Probe design

Extend `packages/kv/scripts/opfs-loss-repro.ts` (on `feat/kv-per-tab-logs`) and its `leveldb-log.ts` dump. Run in three sessions.

**A.** Churn as today, then `kill -9`. Log every acked create, close and remove with its time to the CDP console. This checks claim C1, that no acked operation of the killed session is lost.

**B.** Relaunch and run, in order, each step acked and logged:
1. `createWritable` + `close` of `w0`..`w9` (new names, manifest-like).
2. In a dedicated WebWorker, SyncAccessHandle create + `write` + `flush` + `close` of `f0`..`f4`.
3. Write 40 KiB of throwaway `Paths` records (create and remove one long name).
4. `removeEntry("old", {recursive: true})` on a directory acked in A.
5. Create `late0`..`late4`.

Then close gracefully and dump `Paths`.

**C.** Relaunch and list everything. Read any `w*.crswap`.

Predictions when B started on a torn log:
- The `w*` and `f*` files whose records fell in the block are missing. Their data files remain on disk.
- `old/` stays removed and `late*` exist. This is the hole, a delete that outlives older creates.
- A `wK.crswap` may hold `wK`'s bytes.
- Every A ack is present.

When B started on an intact log, everything is present.

**Control.** Repeat with `--enable-low-end-device-mode`. Torn tails should still occur, and nothing should be lost.

**Safari and Firefox.** Run the same three sessions by hand, killing the browser's processes with `kill -9`. On a Safari without `325091@main`, also kill within 0 to 50 ms after `close()` resolves on a 1 MiB file, and look for the old contents or a truncated file.

**OS crash.** The loop cannot do this. It would need a VM forced off after each step.

## 8. Open questions and "not found"

- **Chromium tracker.** No crbug was found for the `Paths` torn-tail loss. issues.chromium.org pages returned only a sign-in shell to the fetcher, and web searches for `SandboxDirectoryDatabase`, `reuse_logs` and OPFS crash loss found nothing relevant. Whether the repo's draft report was filed is not established.
- **whatwg/fs.** No issue on crash durability of create, remove or `close()` was found (GitHub searches for durability, crash, atomic, fsync and flush). Only #71, #85 and #156 touch flushing.
- **Mozilla Bugzilla.** Searches for OPFS durability, data loss, crash lost, files disappear, `FileSystemSyncAccessHandle` flush and `createWritable` close found only bug 2072928 (performance).
- **WebKit Bugzilla.** Searches found 329088 (above) and 250495 (2023, fixed, SyncAccessHandle data not visible through a new handle). No crash-loss report was found.
- **sqlite.org/wasm.** `persistence.md` makes no durability statement about the `opfs` or `opfs-sahpool` VFS. `api-vfs.md` returned 404.
- **Shipped versions.** Not established for any of these. Which Safari release ships `325091@main`. Which ships dedicated WebWorkers in SharedWorkers. Which Firefox version first exposed `Worker` in SharedWorkers.
- **Platform semantics.** Apple's documentation of `F_BARRIERFSYNC` and `fsync` was not read. Only Chromium's comment about it was. APFS ordering of unsynced creates and unlinks under power loss was not found. Gecko's journal mode is inferred from the missing pragma and the strace report, not checked at runtime.
- **Unobserved Chrome hazards** (inferred, not seen by the repo):
  - The repair-then-delete path on a corrupt `Paths` database (§3.2).
  - A `.crswap` reappearing in place of a lost target.
  - A rolled-back file counter. If the last counter record of a session falls in the dropped block while a later entry that used the number survives, a later create can hit "A stray file detected" and delete that entry's data. (source) `ObfuscatedFileUtil::CreateFile` and `GenerateNewLocalPath`
- **Process placement.** Not established. Which Chrome process hosts the OPFS backend (`FileSystemContext`) on Chrome 156, and so what dies first in a browser kill.
- **Ordering under OS crash in Chrome.** Not established. Whether unsynced LevelDB log pages can reach disk out of order on APFS or ext4.

[fs-close]: https://fs.spec.whatwg.org/#create-a-new-filesystemwritablefilestream
[fs-write]: https://fs.spec.whatwg.org/#api-filesystemwritablefilestream-write
[fs-flush]: https://fs.spec.whatwg.org/#api-filesystemsyncaccesshandle-flush
[fs-sahclose]: https://fs.spec.whatwg.org/#api-filesystemsyncaccesshandle-close
[fs-getfile]: https://fs.spec.whatwg.org/#api-filesystemdirectoryhandle-getfilehandle
[fs-getdir]: https://fs.spec.whatwg.org/#api-filesystemdirectoryhandle-getdirectoryhandle
[fs-remove]: https://fs.spec.whatwg.org/#api-filesystemdirectoryhandle-removeentry
[fs-bucket]: https://fs.spec.whatwg.org/#sandboxed-filesystem
[fs-71]: https://github.com/whatwg/fs/issues/71
[fs-85]: https://github.com/whatwg/fs/pull/85
[fs-156]: https://github.com/whatwg/fs/issues/156
[html-worker]: https://html.spec.whatwg.org/multipage/workers.html#dedicated-workers-and-the-worker-interface
[sq-sync]: https://sqlite.org/pragma.html#pragma_synchronous
[c-sdd-name]: https://github.com/chromium/chromium/blob/7eaf21ddcaccb7c395098a7bfc8384c287280403/storage/browser/file_system/sandbox_directory_database.cc#L72-L73
[c-sdd-write]: https://github.com/chromium/chromium/blob/7eaf21ddcaccb7c395098a7bfc8384c287280403/storage/browser/file_system/sandbox_directory_database.cc#L559-L680
[c-sdd-init]: https://github.com/chromium/chromium/blob/7eaf21ddcaccb7c395098a7bfc8384c287280403/storage/browser/file_system/sandbox_directory_database.cc#L718-L760
[c-env-append]: https://github.com/chromium/chromium/blob/7eaf21ddcaccb7c395098a7bfc8384c287280403/third_party/leveldatabase/env_chromium.cc#L354-L373
[c-env-opts]: https://github.com/chromium/chromium/blob/7eaf21ddcaccb7c395098a7bfc8384c287280403/third_party/leveldatabase/env_chromium.cc#L476-L501
[c-deps]: https://github.com/chromium/chromium/blob/7eaf21ddcaccb7c395098a7bfc8384c287280403/DEPS#L2547-L2548
[c-ofu-move]: https://github.com/chromium/chromium/blob/7eaf21ddcaccb7c395098a7bfc8384c287280403/storage/browser/file_system/obfuscated_file_util.cc#L640-L676
[c-ofu-delete]: https://github.com/chromium/chromium/blob/7eaf21ddcaccb7c395098a7bfc8384c287280403/storage/browser/file_system/obfuscated_file_util.cc#L782-L823
[c-ofu-lost]: https://github.com/chromium/chromium/blob/7eaf21ddcaccb7c395098a7bfc8384c287280403/storage/browser/file_system/obfuscated_file_util.cc#L1157-L1162
[c-ofu-newpath]: https://github.com/chromium/chromium/blob/7eaf21ddcaccb7c395098a7bfc8384c287280403/storage/browser/file_system/obfuscated_file_util.cc#L1469-L1497
[c-swap]: https://github.com/chromium/chromium/blob/7eaf21ddcaccb7c395098a7bfc8384c287280403/content/browser/file_system_access/file_system_access_file_handle_impl.cc#L729-L762
[c-writer-close]: https://github.com/chromium/chromium/blob/7eaf21ddcaccb7c395098a7bfc8384c287280403/content/browser/file_system_access/file_system_access_file_writer_impl.cc#L267-L294
[c-safemove]: https://github.com/chromium/chromium/blob/7eaf21ddcaccb7c395098a7bfc8384c287280403/content/browser/file_system_access/file_system_access_safe_move_helper.cc#L193-L318
[c-runner]: https://github.com/chromium/chromium/blob/7eaf21ddcaccb7c395098a7bfc8384c287280403/storage/browser/file_system/file_system_operation_runner.cc#L293-L294
[c-mountopt]: https://github.com/chromium/chromium/blob/7eaf21ddcaccb7c395098a7bfc8384c287280403/storage/common/file_system/file_system_mount_option.h#L31-L32
[c-sah]: https://github.com/chromium/chromium/blob/7eaf21ddcaccb7c395098a7bfc8384c287280403/third_party/blink/renderer/modules/file_system_access/file_system_access_regular_file_delegate.cc#L127-L130
[c-flush]: https://github.com/chromium/chromium/blob/7eaf21ddcaccb7c395098a7bfc8384c287280403/base/files/file_posix.cc#L674-L708
[c-lowend]: https://github.com/chromium/chromium/blob/7eaf21ddcaccb7c395098a7bfc8384c287280403/base/system/sys_info.cc#L76-L83
[c-worker-idl]: https://github.com/chromium/chromium/blob/7eaf21ddcaccb7c395098a7bfc8384c287280403/third_party/blink/renderer/core/workers/worker.idl#L30-L34
[cr-intent]: https://groups.google.com/a/chromium.org/g/blink-dev/c/KZx0i3e5nZM/m/I7txb1mmAgAJ
[cr-nested-1]: https://github.com/chromium/chromium/commit/304237d65a5d
[cr-nested-2]: https://github.com/chromium/chromium/commit/72c20930dcc9
[l-writer]: https://github.com/google/leveldb/blob/bb74ef739973a70ca9f0d90788a1da89b788c0ad/db/log_writer.cc#L82-L108
[l-reader]: https://github.com/google/leveldb/blob/bb74ef739973a70ca9f0d90788a1da89b788c0ad/db/log_reader.cc#L205-L256
[l-paranoid]: https://github.com/google/leveldb/blob/bb74ef739973a70ca9f0d90788a1da89b788c0ad/db/db_impl.cc#L413-L422
[l-reuse]: https://github.com/google/leveldb/blob/bb74ef739973a70ca9f0d90788a1da89b788c0ad/db/db_impl.cc#L471-L480
[l-sync]: https://github.com/google/leveldb/blob/bb74ef739973a70ca9f0d90788a1da89b788c0ad/db/db_impl.cc#L1236-L1239
[l-opts]: https://github.com/google/leveldb/blob/bb74ef739973a70ca9f0d90788a1da89b788c0ad/include/leveldb/options.h#L171-L185
[l-1287]: https://github.com/google/leveldb/issues/1287
[l-1336]: https://github.com/google/leveldb/pull/1336
[w-handle-create]: https://github.com/WebKit/WebKit/blob/1dcebf501288e669e2f0be0366163d11b094030d/Source/WebKit/NetworkProcess/storage/FileSystemStorageHandle.cpp#L48-L60
[w-remove]: https://github.com/WebKit/WebKit/blob/1dcebf501288e669e2f0be0366163d11b094030d/Source/WebKit/NetworkProcess/storage/FileSystemStorageHandle.cpp#L150-L190
[w-writable]: https://github.com/WebKit/WebKit/blob/1dcebf501288e669e2f0be0366163d11b094030d/Source/WebKit/NetworkProcess/storage/FileSystemStorageHandle.cpp#L262-L321
[w-copy]: https://github.com/WebKit/WebKit/blob/1dcebf501288e669e2f0be0366163d11b094030d/Source/WTF/wtf/FileSystem.cpp#L623-L646
[w-flush]: https://github.com/WebKit/WebKit/blob/1dcebf501288e669e2f0be0366163d11b094030d/Source/WTF/wtf/posix/FileHandlePOSIX.cpp#L73-L76
[w-sah]: https://github.com/WebKit/WebKit/blob/1dcebf501288e669e2f0be0366163d11b094030d/Source/WebCore/Modules/filesystem/FileSystemSyncAccessHandle.cpp#L97-L103
[w-worker-idl]: https://github.com/WebKit/WebKit/blob/1dcebf501288e669e2f0be0366163d11b094030d/Source/WebCore/workers/Worker.idl#L28-L31
[w-pref]: https://github.com/WebKit/WebKit/blob/1dcebf501288e669e2f0be0366163d11b094030d/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml#L7841-L7847
[w-329088]: https://bugs.webkit.org/show_bug.cgi?id=329088
[w-fix]: https://github.com/WebKit/WebKit/commit/b5fe7b3b8f5d761b89d9afe966c5d826632f071a
[w-nested-1]: https://github.com/WebKit/WebKit/commit/343451670f38930c3b2c75d59c2d006b69bab1a0
[w-nested-2]: https://github.com/WebKit/WebKit/commit/29910bc456aab4520f00dbbacf13ca4cb7fee099
[llvm-copy]: https://github.com/llvm/llvm-project/blob/55122cbdf14dfd7e81f830f424f06c4ef7fb4c4d/libcxx/src/filesystem/operations.cpp#L429-L455
[g-conn]: https://github.com/mozilla-firefox/firefox/blob/47f2a88cbab9072c8f8f156494b92d6891e488fb/dom/fs/parent/datamodel/FileSystemDataManager.cpp#L118-L156
[g-unlock]: https://github.com/mozilla-firefox/firefox/blob/47f2a88cbab9072c8f8f156494b92d6891e488fb/dom/fs/parent/datamodel/FileSystemDataManager.cpp#L513-L579
[g-sync]: https://github.com/mozilla-firefox/firefox/blob/47f2a88cbab9072c8f8f156494b92d6891e488fb/storage/mozStorageConnection.cpp#L1474-L1482
[g-merge]: https://github.com/mozilla-firefox/firefox/blob/47f2a88cbab9072c8f8f156494b92d6891e488fb/dom/fs/parent/datamodel/FileSystemDatabaseManagerVersion002.cpp#L773-L888
[g-close]: https://github.com/mozilla-firefox/firefox/blob/47f2a88cbab9072c8f8f156494b92d6891e488fb/dom/fs/parent/FileSystemWritableFileStreamParent.cpp#L37-L80
[g-create]: https://github.com/mozilla-firefox/firefox/blob/47f2a88cbab9072c8f8f156494b92d6891e488fb/dom/fs/parent/datamodel/FileSystemDatabaseManagerVersion001.cpp#L654-L727
[g-mkdir]: https://github.com/mozilla-firefox/firefox/blob/47f2a88cbab9072c8f8f156494b92d6891e488fb/dom/fs/parent/datamodel/FileSystemDatabaseManagerVersion001.cpp#L578-L646
[g-remove]: https://github.com/mozilla-firefox/firefox/blob/47f2a88cbab9072c8f8f156494b92d6891e488fb/dom/fs/parent/datamodel/FileSystemDatabaseManagerVersion001.cpp#L871-L931
[g-sah]: https://github.com/mozilla-firefox/firefox/blob/47f2a88cbab9072c8f8f156494b92d6891e488fb/dom/fs/api/FileSystemSyncAccessHandle.cpp#L443-L470
[g-streams]: https://github.com/mozilla-firefox/firefox/blob/47f2a88cbab9072c8f8f156494b92d6891e488fb/dom/quota/FileStreams.h#L122-L123
[g-nsflush]: https://github.com/mozilla-firefox/firefox/blob/47f2a88cbab9072c8f8f156494b92d6891e488fb/netwerk/base/nsFileStreams.cpp#L233-L242
[g-ptio]: https://github.com/mozilla-firefox/firefox/blob/47f2a88cbab9072c8f8f156494b92d6891e488fb/nsprpub/pr/src/pthreads/ptio.c#L1383-L1396
[g-worker-idl]: https://github.com/mozilla-firefox/firefox/blob/47f2a88cbab9072c8f8f156494b92d6891e488fb/dom/webidl/Worker.webidl#L14-L15
[g-2072928]: https://bugzilla.mozilla.org/show_bug.cgi?id=2072928
