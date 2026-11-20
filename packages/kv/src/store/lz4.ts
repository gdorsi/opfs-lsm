type Decoder = (src: Uint8Array, size: number) => Uint8Array;

/**
 * Set once the wasm engine loads, which an open waits for, so every read of a
 * handle finds it. The decoder lives in the module alone.
 */
let decoder: Decoder | undefined;

/** Returns the decoder it replaced. */
export function useLz4Decoder(next: Decoder | undefined): Decoder | undefined {
  const prev = decoder;
  decoder = next;
  return prev;
}

/** Unpack one LZ4 block of exactly `size` bytes. */
export function lz4Decompress(src: Uint8Array, size: number): Uint8Array {
  return decoder!(src, size);
}
