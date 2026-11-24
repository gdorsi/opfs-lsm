/** CRC-32 (IEEE), the checksum of a manifest's bytes. */
const TABLE = /* @__PURE__ */ Uint32Array.from({ length: 256 }, (_, c) => {
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

export function crc32(data: Uint8Array, seed = 0): number {
  let c = seed ^ 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
