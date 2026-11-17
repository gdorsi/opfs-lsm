/** The position of a batch in the WAL, from 1. 0 is before the first batch. */
export type Seq = number & { readonly __brand: "Seq" };

/** The number of a manifest in `m/`, from 1. 0 is the empty database. */
export type Generation = number & { readonly __brand: "Generation" };

/** Before the first batch. */
export const SEQ_ZERO = 0 as Seq;

/** The empty database, which has no manifest file. */
export const GENERATION_NONE = 0 as Generation;

/** For a number read from disk, IndexedDB or the host protocol. */
export function asSeq(n: number): Seq {
  return n as Seq;
}

/** For a number read from disk, IndexedDB or the host protocol. */
export function asGeneration(n: number): Generation {
  return n as Generation;
}

export function nextSeq(seq: Seq): Seq {
  return (seq + 1) as Seq;
}

export function prevSeq(seq: Seq): Seq {
  return (seq - 1) as Seq;
}

export function nextGeneration(generation: Generation): Generation {
  return (generation + 1) as Generation;
}
