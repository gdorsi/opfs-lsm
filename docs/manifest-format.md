# Manifest format

The byte layout of a manifest, `m/<generation>.mft`. What a manifest means is in
[design.md](design.md#manifest-format).

```layout
| u32 magic       "OLGN" (0x4f4c474e)                                        |
| u32 version     6                                                          |
| u64 generation                                                             |
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
| u32 block count                                                            |
| varint separator length, varint block length        once per block         |
| separators      back to back, in block order                               |

marks block:
| u32 count       0 is valid: no marks                                       |
| mark 0                                                                     |
| ...                                                                        |

per mark:
| u32 start length                                                           |
| start           the first key of the range                                 |
| u8 has end                                                                 |
| u32 length, end key   exclusive   (if has end)                             |
| u64 through                                                                |
| u64 at                                                                     |
```

`bytes` and the key range let the compaction planner size and route levels without opening a
file. The level of a run is in its path.

The last three fields are the run's block index, which lets a tab read any block without reading
the run's own index first ([design.md](design.md#reading-a-run)). The blocks are back to back from
offset 0, so the block lengths before a block add up to its offset, and all of them to the offset
of the run's bloom filter. The separator of a block is the shortest prefix of its first key that
sorts above the last key of the block before it, and the whole first key for block 0. A key can
only be in the last block whose separator is not above it. Varints are unsigned LEB128, at most 5
bytes.

Runs are listed L0 first, newest first. Each deeper level follows, with its runs sorted by
smallest key. Reads use that order directly.

The marks block holds the marks, in no particular order, and `marksThrough` is a run's claim
against them. [design.md](design.md#range-deletes) gives the meaning of both.

A reader rejects any other version as corrupt, and a marks block that breaks its rules, a
mark with `through` 0, an end not above its start, `at` at or below its `through` or past the
manifest's `through`, a run whose `marksThrough` is past it, a block count that the bytes left
cannot hold, or blocks that end past the run's `bytes`.
