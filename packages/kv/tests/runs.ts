import { Miss, type LayerCursor, type LayerEntry } from "../src/store/cursor.js";
import { PageCache } from "../src/store/page-cache.js";
import { sstKeyRange } from "../src/store/sst.js";
import { bytesFile, SstReader } from "../src/store/sst-reader.js";

export { bytesFile };

/** A lazy reader over a run held in memory, routed by the range its manifest entry would record. */
export function readerOfBytes(buf: Uint8Array, cache = new PageCache()): SstReader {
  return new SstReader(bytesFile(buf), cache, sstKeyRange(buf));
}

/** Every entry left in `cursor`, waiting out its misses. */
export async function drain(cursor: LayerCursor): Promise<LayerEntry[]> {
  const out: LayerEntry[] = [];
  for (;;) {
    const e = cursor.peek();
    if (e instanceof Miss) {
      await e.ready;
      continue;
    }
    if (!e) return out;
    out.push(e);
    cursor.next();
  }
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
