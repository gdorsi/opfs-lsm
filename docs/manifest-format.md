# Manifest format

The byte layout of a manifest, `m/<generation>.mft`. What a manifest means is in
[design.md](design.md#manifest-format).

```
| u32 magic       "OLGN" (0x4f4c474e)                                        |
| u32 version     3                                                          |
| u64 generation                                                             |
| u64 tombstoneSeq                                                           |
| u64 through                                                                |
| u32 run count                                                              |
| run 0                                                                      |
| ...                                                                        |
| u32 crc32       of every byte before it                                    |

per run:
| u16 path length                                                            |
| path            UTF-8, relative to the database root                       |
| u32 bytes       size of the run file                                       |
| u8 has range                                                               |
| u32 length, smallest key, u32 length, largest key   (if has range)         |
```

`tombstoneSeq` is the highest seq of any delete that a bottom-level compaction dropped.

`bytes` and the key range let the compaction planner size and route levels without opening a
file. The level of a run is in its path.

Runs are listed L0 first, newest first. Each deeper level follows, with its runs sorted by
smallest key. Reads use that order directly.

A reader rejects any other version as corrupt.
