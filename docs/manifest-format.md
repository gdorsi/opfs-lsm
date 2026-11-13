# Manifest format

The byte layout of a manifest, `m/<generation>.mft`. What a manifest means is in
[design.md](design.md#manifest-format).

```
| u32 magic       "OLGN" (0x4f4c474e)                                        |
| u32 version     4                                                          |
| u64 generation                                                             |
| u64 tombstoneSeq                                                           |
| u64 through                                                                |
| marks block                                                                |
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
| u64 marksThrough                                                           |

marks block:
| u32 piece count (at least 1)                                               |
| piece 0                                                                    |
| ...                                                                        |

per piece:
| u32 start length                                                           |
| start           the first key of the piece                                 |
| u64 through                                                                |
| u64 at                                                                     |
```

`tombstoneSeq` is the highest seq of any delete that a bottom-level compaction dropped.

`bytes` and the key range let the compaction planner size and route levels without opening a
file. The level of a run is in its path.

Runs are listed L0 first, newest first. Each deeper level follows, with its runs sorted by
smallest key. Reads use that order directly.

The marks block holds the pieces of the mark table, and `marksThrough` is a run's claim
against it. [design.md](design.md#range-deletes) gives the meaning of both. The first piece
starts at the empty key, starts strictly increase, and two adjacent pieces never hold the same
`through` and `at`.

A reader rejects any other version as corrupt, and a marks block that breaks its rules, a
piece with `at` at or below its nonzero `through` or past the manifest's `through`, or a run
whose `marksThrough` is past it.
