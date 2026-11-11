/** `length` bytes at `offset`, in a buffer nothing else holds. */
export type ReadSpan = (offset: number, length: number) => Promise<ArrayBuffer>;

type Want = {
  readonly offset: number;
  readonly length: number;
  readonly resolve: (bytes: Uint8Array) => void;
  readonly reject: (err: unknown) => void;
};

/**
 * Two wants closer than this share a span, and the bytes between them are
 * read and dropped. In Chrome a read costs about as much as 128 KiB to
 * 256 KiB of extra bytes (docs/research/coalesced-page-reads.md).
 */
const MAX_GAP = 128 * 1024;
/** A span is copied out want by want, so its size is extra memory while it lands. */
const MAX_SPAN = 1024 * 1024;
/**
 * Microtask turns with no new want before a batch is read. Callers that
 * woke on the same promise reach their read a turn or two apart.
 */
const QUIET_TURNS = 2;

/**
 * A `read(offset, length)` over one immutable file that serves the reads
 * of a batch with one `readSpan` per run of nearby ranges. A batch is
 * every read issued before the microtask queue goes quiet, so a lone read
 * starts within the same task. Each result is its own buffer: dropping
 * one frees its bytes whatever happens to the others.
 */
export function coalesceReads(readSpan: ReadSpan): (offset: number, length: number) => Promise<Uint8Array> {
  let batch: Want[] = [];

  const issue = (wants: readonly Want[]): void => {
    const from = wants[0]!.offset;
    const to = wants.reduce((end, w) => Math.max(end, w.offset + w.length), from);
    readSpan(from, to - from).then(
      (span) => {
        if (wants.length === 1) return wants[0]!.resolve(new Uint8Array(span));
        for (const w of wants) w.resolve(new Uint8Array(span.slice(w.offset - from, w.offset - from + w.length)));
      },
      (err: unknown) => {
        for (const w of wants) w.reject(err);
      },
    );
  };

  const drain = async (): Promise<void> => {
    for (let quiet = 0, seen = batch.length; quiet < QUIET_TURNS; ) {
      await null;
      if (batch.length > seen) {
        seen = batch.length;
        quiet = 0;
      } else quiet++;
    }
    const wants = batch.sort((a, b) => a.offset - b.offset);
    batch = [];
    let first = 0;
    let end = wants[0]!.offset + wants[0]!.length;
    for (let i = 1; i < wants.length; i++) {
      const w = wants[i]!;
      const joined = Math.max(end, w.offset + w.length);
      if (w.offset - end > MAX_GAP || joined - wants[first]!.offset > MAX_SPAN) {
        issue(wants.slice(first, i));
        first = i;
        end = w.offset + w.length;
      } else end = joined;
    }
    issue(wants.slice(first));
  };

  return (offset, length) =>
    new Promise<Uint8Array>((resolve, reject) => {
      batch.push({ offset, length, resolve, reject });
      if (batch.length === 1) void drain();
    });
}
