/**
 * The runtime the build passes to asc in place of AssemblyScript's: `new` and
 * the `heap` builtins allocate from alloc.ts and trap when memory cannot
 * grow. The module allocates nothing managed, so there is no collector.
 */
import { free, tryAlloc, tryRealloc } from "./alloc";

// @ts-ignore: decorator
@global @unsafe
function __alloc(size: usize): usize {
  const ptr = tryAlloc(size);
  if (!ptr) unreachable();
  return ptr;
}

// @ts-ignore: decorator
@global @unsafe
function __realloc(ptr: usize, size: usize): usize {
  const moved = tryRealloc(ptr, size);
  if (!moved) unreachable();
  return moved;
}

// @ts-ignore: decorator
@global @unsafe
function __free(ptr: usize): void {
  free(ptr);
}
