# SST file format

The byte layout of a run, `l<n>/*.sst`. How a tab reads one is in
[design.md](design.md#reading-a-run).

A run is data blocks, a bloom filter and a fixed-size footer, back to back. A writer produces
the sections in that order without knowing the key count up front. A reader finds the footer as
the last 24 bytes of the file.

```
================================== SST file ==================================
| data block 0                                                               |
| ...                                                                        |
| data block N-1                                                             |
------------------------------------------------------------------------------
| bloom bits                                                                 |
------------------------------------------------------------------------------
| footer (24 bytes)                                                          |
==============================================================================
```

Entries are sorted by key, with one entry per key.

The file holds no index of its blocks. Its writer reports one, and the manifest that lists the
run records it ([manifest-format.md](manifest-format.md)). The blocks sit back to back from
offset 0, so a reader with the file alone finds each one where the block before it ends: a
block's record count gives how many records follow its prefix and how long its offset table is.

## Data block

```layout
| u32 record count                                                           |
| varint prefix length                                                       |
| prefix                                                                     |
| record 0                                                                   |
| ...                                                                        |
| record count - 1                                                           |
| u16 offset of record 4                              from the block start   |
| u16 offset of record 8                                                     |
| ...                                                                        |
```

`prefix` is the longest prefix that every key in the block shares. A key is the prefix followed
by the suffix of its record. A block with one key stores the whole key as its prefix.

`offset` entries, one per 4th record after record 0, let a reader binary-search the block. Every
record holds a whole suffix, so a reader compares any record from its offset alone. A block of 4 records or fewer has no offset entries.

A block ends before the record that would take its encoded size past 32 KiB. A block of one
record can be larger, and it has no offset table.

Integers are little-endian. Varints are unsigned LEB128, at most 5 bytes.

## Record

```layout
| u8 tag          1 = put, 2 = delete                                        |
| u64 seq         the WAL seq that wrote the key                             |
| varint suffix length                                                       |
| suffix          the key after the block prefix                             |
| varint value length                                 (puts only)            |
| value                                               (puts only)            |
```

## Footer (24 bytes)

```
<----------------------------------- 4 bytes ----------------------------------->
| entry count                                                                   |
| data length                                                                   |
| bloom hash count                                                              |
| crc32                                                                         |
| version                                                                       |
| magic                                                                         |
```

`data length` is the size of the data blocks together. The bloom filter runs from that offset to
the footer.

`crc32` is the IEEE CRC-32 of every byte before the field.

`version` must be 3. Any other version is rejected.

`magic` must be `OLST` (0x4f4c5354).

A reader also rejects a footer whose `data length` passes the start of the footer, or that names
more than 32 bloom hashes, before the count sets a loop.

## Bloom filter

The filter uses 10 bits per key and 7 hashes, about a 1% false-positive rate. The hashes are
FNV-1a and a 32-bit mix of it, combined by double hashing.
