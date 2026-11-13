# SST file format

The byte layout of a run, `l<n>/*.sst`. How a tab reads one is in
[design.md](design.md#reading-a-run).

A run is data blocks, a bloom filter, a block index and a fixed-size footer, back to back. A
writer produces the sections in that order without knowing the key count up front. A reader
finds the footer as the last 44 bytes of the file.

```
================================== SST file ==================================
| data block 0                                                               |
| ...                                                                        |
| data block N-1                                                             |
------------------------------------------------------------------------------
| bloom bits                                                                 |
------------------------------------------------------------------------------
| index entry 0                                                              |
| ...                                                                        |
| index entry N-1                                                            |
------------------------------------------------------------------------------
| footer (44 bytes)                                                          |
==============================================================================
```

Entries are sorted by key, with one entry per key. A reader rejects a file whose sections are
not contiguous.

## Data block

```
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
record holds a whole suffix, so a reader compares any record from its offset alone.

A block ends before the record that would take its encoded size past 4 KiB. A block of one
record can be larger, and it has no offset table.

Varints are unsigned LEB128, at most 5 bytes.

With codec 1 (LZ4), each block is stored packed. Index offsets, the bloom offset and the CRC
refer to the stored bytes.

```
| u32 unpacked length                                                        |
| LZ4 block-format bytes of the block above                                  |
```

## Record

```
| u8 tag          1 = put, 2 = delete                                        |
| u64 seq         the WAL seq that wrote the key                             |
| varint suffix length                                                       |
| suffix          the key after the block prefix                             |
| varint value length                                 (puts only)            |
| value                                               (puts only)            |
```

## Index entry

One entry per data block, in block order.

```
| u32 first key length                                                       |
| first key       the smallest key of the block                              |
| u32 last key length                                                        |
| last key        the largest key of the block                               |
| u32 block offset                                    from the start of file |
| u32 block length                                                           |
```

## Footer (44 bytes)

```
<----------------------------------- 4 bytes ----------------------------------->
| entry count                                                                   |
| block count                                                                   |
| bloom offset                                                                  |
| bloom length                                                                  |
| bloom hash count                                                              |
| index offset                                                                  |
| index length                                                                  |
| codec                                                                         |
| crc32                                                                         |
| version                                                                       |
| magic                                                                         |
```

`bloom offset` is also the length of the data section.

`codec` is 0 for raw blocks and 1 for LZ4.

`crc32` is the IEEE CRC-32 of every byte before the field.

`version` must be 1. Any other version is rejected.

`magic` must be `OLST` (0x4f4c5354).

A reader also rejects a footer that names more than 32 bloom hashes, or more blocks than the
index has room for, before either sets a loop count or an allocation.

## Bloom filter

The filter uses 10 bits per key and 7 hashes, about a 1% false-positive rate. The hashes are
FNV-1a and a 32-bit mix of it, combined by double hashing.

## Compression

Runs in L2 and deeper use LZ4. L0 and L1 runs stay raw. L0 and L1 hold the recent writes, and
an LZ4 block costs a decompress on every read of it. The deeper levels hold nearly all of the
bytes.

A decoder rejects a block whose unpacked length claims more than LZ4 can produce from the
stored bytes, before it allocates.
