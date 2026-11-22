/**
 * The module's allocator, and no garbage collector, since nothing in the
 * module is managed. Free blocks
 * form one list in address order, and an allocation takes the first that
 * fits. Memory grows by exactly what an allocation lacks. `tryAlloc` and
 * `tryRealloc` return 0 when memory cannot grow, so a merge session can
 * report OUT_OF_MEMORY; `new` and the `heap` builtins (runtime.ts) trap
 * instead.
 *
 * A block is a u32 header, its size in bytes with the header and bit 0 set
 * while it is free, then its payload. Blocks start 4 bytes past a multiple
 * of 8, so payloads are 8-byte aligned, and their sizes are multiples of 8.
 * A free block's payload starts with the address of the next free block.
 */

const HEADER: usize = 4;
const FREE: usize = 1;
/** A header and the next free block's address, rounded up. */
const MIN_BLOCK: usize = 16;
/** Past this a block size would not fit a 32-bit address space. */
const MAX_PAYLOAD: usize = 0x7fff0000;

/** The first free block, or 0. */
let list: usize = 0;
/** Where the heap ends: 4 bytes before the end of memory, so the last block ends 4 bytes past a multiple of 8. 0 until the first allocation. */
let end: usize = 0;

@inline function sizeOf(block: usize): usize {
  return load<usize>(block) & ~FREE;
}

@inline function isFree(block: usize): bool {
  return (load<usize>(block) & FREE) != 0;
}

@inline function nextOf(block: usize): usize {
  return load<usize>(block, HEADER);
}

@inline function setNext(prev: usize, block: usize): void {
  if (prev) store<usize>(prev, block, HEADER);
  else list = block;
}

@inline function blockSize(payload: usize): usize {
  return max((payload + HEADER + 7) & ~7, MIN_BLOCK);
}

/** Make the `size` bytes at `block` a free block, between `prev` and `next` on the list. */
@inline function link(prev: usize, block: usize, size: usize, next: usize): void {
  store<usize>(block, size | FREE);
  store<usize>(block, next, HEADER);
  setNext(prev, block);
}

/** The last free block, or 0. */
function last(): usize {
  let block: usize = 0;
  for (let b = list; b; b = nextOf(b)) block = b;
  return block;
}

/** Grow memory by at least `bytes` and add them as free space at the end of the heap. False when memory cannot grow. */
function grow(bytes: usize): bool {
  if (memory.grow(<i32>((bytes + 0xffff) >>> 16)) < 0) return false;
  const top = (<usize>memory.size() << 16) - HEADER;
  const prev = last();
  if (prev && prev + sizeOf(prev) == end) store<usize>(prev, (sizeOf(prev) + top - end) | FREE);
  else link(prev, end, top - end, 0);
  end = top;
  return true;
}

/** `size` bytes, or 0 when memory cannot grow. */
export function tryAlloc(size: usize): usize {
  if (!end) {
    // The heap starts after the static data, with the rest of its page free.
    end = ((__heap_base + HEADER + 7) & ~7) - HEADER;
    const top = (<usize>memory.size() << 16) - HEADER;
    if (top >= end + MIN_BLOCK) {
      link(0, end, top - end, 0);
      end = top;
    }
  }
  if (size > MAX_PAYLOAD) return 0;
  const need = blockSize(size);
  while (true) {
    let prev: usize = 0;
    for (let b = list; b; b = nextOf(b)) {
      const have = sizeOf(b);
      if (have >= need) {
        const next = nextOf(b);
        if (have - need >= MIN_BLOCK) {
          link(prev, b + need, have - need, next);
          store<usize>(b, need);
        } else {
          setNext(prev, next);
          store<usize>(b, have);
        }
        return b + HEADER;
      }
      prev = b;
    }
    const tail = last();
    const room = tail && tail + sizeOf(tail) == end ? sizeOf(tail) : 0;
    if (!grow(need - room)) return 0;
  }
}

/**
 * `ptr` grown to `size` bytes: in place when the block after it is free and
 * large enough, or at the end of the heap; else moved. 0, with `ptr`
 * untouched, when memory cannot grow.
 */
export function tryRealloc(ptr: usize, size: usize): usize {
  if (!ptr) return tryAlloc(size);
  if (size > MAX_PAYLOAD) return 0;
  const block = ptr - HEADER;
  const have = sizeOf(block);
  const need = blockSize(size);
  if (need <= have) return ptr;
  const after = block + have;
  if (after == end || (isFree(after) && after + sizeOf(after) == end)) {
    const room = after == end ? have : have + sizeOf(after);
    if (room < need && !grow(need - room)) return 0;
  }
  if (after != end && isFree(after) && have + sizeOf(after) >= need) {
    const total = have + sizeOf(after);
    const next = nextOf(after);
    let prev: usize = 0;
    for (let b = list; b != after; b = nextOf(b)) prev = b;
    if (total - need >= MIN_BLOCK) {
      link(prev, block + need, total - need, next);
      store<usize>(block, need);
    } else {
      setNext(prev, next);
      store<usize>(block, total);
    }
    return ptr;
  }
  const moved = tryAlloc(size);
  if (!moved) return 0;
  memory.copy(moved, ptr, have - HEADER);
  free(ptr);
  return moved;
}

export function free(ptr: usize): void {
  if (!ptr) return;
  const block = ptr - HEADER;
  let size = sizeOf(block);
  let prev: usize = 0;
  let next = list;
  while (next && next < block) {
    prev = next;
    next = nextOf(next);
  }
  if (next && block + size == next) {
    size += sizeOf(next);
    next = nextOf(next);
  }
  if (prev && prev + sizeOf(prev) == block) {
    store<usize>(prev, (sizeOf(prev) + size) | FREE);
    store<usize>(prev, next, HEADER);
  } else {
    link(prev, block, size, next);
  }
}
