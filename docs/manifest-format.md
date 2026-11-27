# Manifest format

The byte layout of a manifest, `m/<generation>.mft`, with the generation written as 16 digits, zero-padded. All integers are little-endian. What a manifest means is in
[design.md](design.md#manifest-format).

```layout
| u32 magic       "OLGN" (0x4f4c474e)                                        |
| u32 version     6                                                          |
| u64 generation                                                             |
| u64 through                                                                |
| u32 head bytes  the size of the head, its CRC included                     |
| marks block                                                                |
| u32 run count                                                              |
| run 0                                                                      |
| ...                                                                        |
| u32 crc32       of every byte before it: the head ends here                |
| index of run 0                                                             |
| ...                                                                        |

per run:
| u16 path length                                                            |
| path            UTF-8, relative to the database root                       |
| u32 bytes       size of the run file                                       |
| u8 has range                                                               |
| u32 length, smallest key, u32 length, largest key   (if has range)         |
| u64 marksThrough                                                           |
| u32 index bytes the size of the run's index, after the head                |

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

index:
| u32 block count                                                            |
| varint separator length, varint block length        once per block         |
| separators      back to back, in block order                               |
| u32 crc32       of every byte of the index before it                       |
```

The head is everything a planner or a recovery reads. IndexedDB keeps a copy of the head alone
([design.md](design.md#installing-a-generation)), so what a flush records there grows with the
count of runs, not of blocks.

`bytes` and the key range let the compaction planner size and route levels without opening a
file. The level of a run is the `n` of its path's `l<n>/` directory.

A run's index is the only index of its blocks: the run file holds none
([sst-format.md](sst-format.md)). A tab reads any block of the run with it
([design.md](design.md#reading-a-run)), and a compaction takes the length of each block of an
input from it ([design.md](design.md#merging)). The indexes follow the head in run order, each as
long as its run's `index bytes`, and the file ends with the last one. A tab checks and decodes an
index when it first reads the run. The blocks are back to back from
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
manifest's `through`, a run whose `marksThrough` is past it, a run whose path names no level, a
`head bytes` past the file, or
indexes that do not end with the file. An index whose CRC does not match, whose block count the
bytes cannot hold, or whose blocks end past the run's `bytes` is refused when a tab first reads
the run: the manifest still decodes, and that run's read throws. A compaction refuses an input
whose index fails the same checks, or whose block lengths do not add up to the data length in
the run's footer.
