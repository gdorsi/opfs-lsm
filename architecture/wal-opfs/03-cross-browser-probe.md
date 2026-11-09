# Cross-browser probe: SyncAccessHandle locking and costs

Run 2026-11-08 on an Apple M5 Max (macOS). Safari 26.6.2 and Firefox 152, both
real apps, page served from localhost with COOP/COEP (timer resolution 20 µs).
Two runs per browser, consistent with each other. Chrome numbers are from
`00-grounding.md` (Chrome 156).

## Behaviour

| | Chrome 156 | Safari 26.6 | Firefox 152 |
|---|---|---|---|
| `mode: "readwrite-unsafe"`, second handle from another worker | works | fails `InvalidStateError` (option ignored, still exclusive) | fails `NoModificationAllowedError` (same) |
| default mode, second handle from another worker | fails | fails `InvalidStateError` | fails `NoModificationAllowedError` |
| `getFile()` + read while another worker holds an exclusive handle (main thread and SharedWorker) | works | works | works |
| `File` taken before a write, read after it | throws `NotReadableError` | old snapshot, no error | **live contents** (new size), no error |
| `removeEntry` while a handle is open | fails | **succeeds** | fails |
| holder worker terminated, another worker reopens | — | works after ~6 ms | works after ~5 ms |

## Costs (µs, 100-byte write)

| | Chrome | Safari | Firefox |
|---|---:|---:|---:|
| IndexedDB readwrite tx, relaxed (p50 / mean) | ~195 | 200 / 247 | **80 / 76** |
| write on a held handle (mean) | ~21 incl. round trip | 2–3 | 44–49 |
| held write + `flush()` (mean) | ~500 | 24 | 102 |
| open + write + close, file handle cached (p50) | not measured | 140–180 | 840–920 |
| Web Lock acquire (p50) | 50 | 40–60 | 20 |
| Web Lock + open + write + close (p50 / mean) | not measured | 200–240 / 243–251 | 840–1000 / 925–1096 |
| create a new file + open + close (p50) | not measured | 160 | 1220 |
| main thread ↔ dedicated worker round trip (mean) | ~20 | 22–26 | 11–13 |

## What it means for the design

- `readwrite-unsafe` is Chrome-only. Elsewhere only one handle per file
  exists at a time, so whoever writes must hold it exclusively.
- **Opening per lock hold is a dead end.** A put would cost about 270 µs on
  Safari (no gain over IndexedDB's ~250) and ~950 µs on Firefox (12× worse
  than IndexedDB's ~76).
- **A tab that keeps the lock and the handle across a burst of writes**
  pays a round trip plus a held write: ~30 µs on Safari (about 8× faster than
  IndexedDB) and ~60 µs on Firefox (about even with IndexedDB). A handoff
  between tabs then costs one lock transfer plus an open: ~250 µs on Safari,
  ~1 ms on Firefox.
- Readers can keep using `getFile()` everywhere. A snapshot can be stale
  (Safari), throw (Chrome) or read live bytes (Firefox), and the commit rule
  (whole frame, CRC valid, seq + 1) handles all three: a half-written frame
  fails its CRC and ends the read.
- Safari lets `removeEntry` delete an open file. Reclaim only removes sealed,
  covered segments, which no writer writes to, so this is safe as long as
  that rule holds; it no longer doubles as a guard.
- A dead tab's handle is released when its worker goes away (~5 ms), so crash
  recovery needs nothing extra. A frozen, not dead, tab is still untested.
