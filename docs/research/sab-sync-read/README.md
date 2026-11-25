# Sync reads through a SharedArrayBuffer: probe

Throwaway. Times one read of a 32 KiB page from a 16 MiB OPFS file in headless Chrome, by each
way a tab could ask for it:

- `file.slice().arrayBuffer()` on the main thread, as kv reads today;
- a dedicated worker with a read-only sync access handle, asked by `postMessage`;
- the same worker asked through a SharedArrayBuffer, with the main thread awaiting
  `Atomics.waitAsync` or spinning on `Atomics.load`, and the worker blocked in `Atomics.wait`,
  parked on `Atomics.waitAsync`, or spinning for a while after each read.

It also times 450 pages asked for at once, reads of 4 KiB to 1 MiB, the worker's start, and
opening 64 files each way. Every read is checked against the bytes written.

```sh
node docs/research/sab-sync-read/run.mjs [launches=3] [rounds=8]
```

Each launch is a fresh Chrome profile. Results print as tables and are saved to `results/`.
The page is served cross-origin isolated, which a SharedArrayBuffer needs.

The kv side, and a `--sync-reads` flag that runs a benchmark with it, are in
[PR 454](https://github.com/gdorsi/opfs-lsm/pull/454).
