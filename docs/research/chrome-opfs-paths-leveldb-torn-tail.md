# Chrome forgets OPFS entries after a browser crash (torn `Paths` LevelDB log)

A draft bug report for crbug.com (component Blink>Storage>FileSystem).

## Summary

After a browser crash, OPFS files and directories that a later session created or removed can
be forgotten one launch after that. The file data stays on disk; the names are gone.

Chrome keeps OPFS names in a LevelDB per storage bucket, `<profile>/Default/File System/<n>/t/Paths`.
A crash can leave its log (`NNNNNN.log`) ending in a 7-byte record header with no payload. The
next launch treats the torn header as the end of the log and reuses the log, appending its
records right after it. At the launch after that, LevelDB's log reader reads the orphan header,
whose length now spans the new records, fails the checksum, and drops the rest of that 32 KiB
block. Every create and remove the middle session wrote in that block is lost: files and
directories it created are missing (a directory takes its children with it), and entries it
removed come back.

Expected: a torn tail is truncated (or the log is not reused) before new records are appended,
so what a session wrote after recovery survives.

## Version

Google Chrome 156.0.8078.80, macOS 26 (Darwin 25.6), headless (`--headless=new`) and fresh
profiles. Not tried on other platforms or channels.

## Steps to reproduce

No site code beyond plain OPFS calls. A script that does the steps below and reads the LevelDB log
is in this repository: `packages/kv/scripts/opfs-loss-repro.ts` (driver over CDP) and
`packages/kv/scripts/leveldb-log.ts` (log reader that flags bad records).

1. Session A: on an http://127.0.0.1 page, two dedicated WebWorkers loop creating, writing
   (SyncAccessHandle), and removing small files in OPFS, and the page loops `createWritable` on
   other files. After 0.5 to 3 s, crash the browser (CDP `Browser.crash`, or `kill -9` of the
   browser process).
2. Session B: relaunch on the same profile. Create 20 marker files in an existing OPFS
   directory. Close Chrome gracefully (CDP `Browser.close`).
3. Session C: relaunch and list the marker directory.

```sh
node packages/kv/scripts/opfs-loss-repro.ts --kill crash --mode none --iterations 45
```

## Evidence

- About one crash in ten (21 of 180) leaves the `Paths` log with a torn tail (a record header cut off at end
  of file). When it does, session C misses the markers whose records landed in the rest of that
  block.
- `leveldb-log.ts` on the log after session B shows a record at the old end of file whose
  checksum fails and whose dropped bytes hold session B's marker names.
- Waiting in session B (5 s), writing one small file first, or an idle session between A and B
  does not help. Writing more than 32 KiB of `Paths` records first (create and remove
  throwaway entries) moves session B's records into the next block, and nothing is lost.

Measured with the repro script, `--kill crash`:

| Session B does first | Iterations that lost markers | Torn after the crash | Lost given torn |
|---|---|---|---|
| nothing (`--mode none`) | 5/45 | 5/45 | 5/5 |
| one create+remove of a 12,000-character directory name (`--mode engine`) | 0/135 | 16/135 | 0/16 |

## Workaround in this repository

`packages/kv/src/opfs/root.ts` pads once per browser session, before any OPFS create or remove,
by creating and removing a directory with a 12,000-character name in the OPFS root: about 36 KiB
of `Paths` records (36,274 bytes measured) in one pair of calls, 0.5 ms. A create and remove of a name of
length L writes about 3L + 250 bytes to the log.
