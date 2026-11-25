/**
 * What a tab and its sync-read worker share: one SharedArrayBuffer and three
 * messages. A read crosses in the buffer alone. The tab writes `FILE`, the
 * offset and `LEN`, stores a new id in `REQ`, adds one to `WAKE` and notifies
 * it. The worker reads into the data region, writes `STATUS`, then stores
 * the id in `DONE`, which the tab spins on.
 */

/** Int32 slots of the control region. */
export const WAKE = 0;
export const DONE = 1;
export const REQ = 2;
export const FILE = 3;
/** The offset is a file position, so it takes two slots. */
export const OFF_LO = 4;
export const OFF_HI = 5;
export const LEN = 6;
/** Bytes read, or -1 when the read failed. */
export const STATUS = 7;

export const CONTROL_BYTES = 64;
/** The longest read one request carries. */
export const DATA_BYTES = 2 * 1024 * 1024;

export type ToWorker =
  | { readonly kind: "init"; readonly buffer: SharedArrayBuffer }
  /** Open `name` of `folder`, a path from the OPFS root, as file number `file`. */
  | { readonly kind: "open"; readonly id: number; readonly file: number; readonly folder: string; readonly name: string }
  | { readonly kind: "close"; readonly id: number; readonly file: number };

export type FromWorker =
  /** The answer to `init`: whether this browser has what the worker needs. */
  | { readonly kind: "init"; readonly supported: boolean }
  /** The answer to the `open` or `close` with this id. A close is always `ok`. */
  | { readonly kind: "done"; readonly id: number; readonly ok: boolean };
