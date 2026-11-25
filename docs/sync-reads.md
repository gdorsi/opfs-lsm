# Sync reads

How a tab reads a run with no wait when it opens with `openDb({ syncReads })`, and what keeps
that safe. What a run is and how it is read otherwise is in
[design.md](design.md#reading-a-run).

`syncReads` is the export of `@opfs-lsm/kv/sync-reads`. A page that does not import that entry
bundles none of this. The option takes effect only when all of these hold:

- The page has `SharedArrayBuffer`, which a browser gives only to a cross-origin isolated page.
- The page can start a dedicated worker and post the buffer to it.
- In that worker, a sync access handle has a `mode`, so a file can be opened `read-only`, and
  `Atomics.waitAsync` exists.

Where one is missing, the database opens and reads as it does without the option. Nothing reports
it.

## The worker

A page has one dedicated worker, named `opfs-lsm-sync-reads`, for every database it opens with
the option. The worker holds one sync access handle, opened `read-only`, for each run file a tab
of the page holds open. The tab starts the worker when `openDb` is called and never waits for it:
an open resolves when it would without the option.

The worker and the tab share one buffer, with a control region of 16 32-bit integers followed by
2 MiB of data:

```layout
| i32 0  WAKE     the tab adds 1 and notifies for each request            |
| i32 1  DONE     the worker stores the id of the request it answered     |
| i32 2  REQ      the tab stores the id of its request                    |
| i32 3  FILE     the number the tab gave the file when it asked for it   |
| i32 4  OFF_LO   the low 32 bits of the offset                           |
| i32 5  OFF_HI   the high bits of the offset                             |
| i32 6  LEN      the bytes asked for                                     |
| i32 7  STATUS   the bytes read, or -1                                   |
| 32 bytes unused                                                        |
| data            2 MiB                                                   |
```

Opening and closing a handle go by message, and each is answered. A read uses the buffer alone.

## A read

A tab asks for a file's handle once it holds the run's shared Web Lock and has found the file
([Loading a generation under churn](design.md#loading-a-generation-under-churn)). Until the
worker answers, the file is not ready.

To read `LEN` bytes of a ready file, the tab:

1. Writes `FILE`, the offset and `LEN`.
2. Stores a new id in `REQ`, adds 1 to `WAKE` and notifies it.
3. Loads `DONE` in a loop until it holds that id.
4. Takes the read as failed unless `STATUS` equals `LEN`.
5. Copies the bytes out of the data region.

The worker reads the file straight into the data region, writes `STATUS`, then stores the id in
`DONE`. After a read it keeps loading `WAKE` for about 4,000 loads, so the next read of a burst
finds it awake, then parks with `Atomics.waitAsync`. It never blocks: a blocked worker takes no
message, so it could not open or close a handle.

A read goes the async way, as without the option, when:

- the file is not ready, or the read is longer than the data region;
- the read failed in the worker, which leaves the async read to report what is wrong;
- the tab gave up on an earlier read.

A read issued while its file's handle is opening waits for the handle first, so the first reads
after an open cost one wait and not one async read each. It does not wait for a worker that has
been starting for more than 20 ms.

The tab gives up on a read after 20 ms without an answer. From then on it never reads the buffer
again, since the worker may still write to it, and every read of the page is async. The worker
stays to close its handles.

A scan on a ready file asks for no block ahead of the one it enters.

## Closing

A read-only handle on a file stops the file's removal, so two rules order every close:

- A run's handle closes before the tab releases the run's Web Lock. The host removes a run only
  under that lock, so it never meets a handle.
- No handle on a database's files is open once the tab's connection to the WAL database has
  closed. `db.close()` closes every handle first and resolves after. A connection that
  `destroyDb` asks to close does the same before it closes, so the folder is removed only after
  every handle is closed ([Removing](design.md#removing)).

A `view` can hold a run past either close. Its handle is closed all the same, and the run reads
the async way from then on.

## Assumptions about the platform

1. A sync access handle opened `read-only` allows other `read-only` handles and `getFile()` on
   the same file. Until it closes, the browser refuses `removeEntry`, `createWritable()` and a
   read-write handle on that file.
2. `read()` on a sync access handle accepts a view on a `SharedArrayBuffer`.
3. The browser closes the handles of a worker when its page goes away.
