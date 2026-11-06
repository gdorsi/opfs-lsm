/* tslint:disable */
/* eslint-disable */

/**
 * Decode SST bytes to JS array of entries.
 */
export function decode_sst_js(buf: Uint8Array): Array<any>;

/**
 * Encode entries from JS: `[{kind:'put'|'del', key:Uint8Array, value?:Uint8Array, seq?:number}, ...]`
 */
export function encode_sst_js(entries: Array<any>, lz4: boolean): Uint8Array;

/**
 * Unpack one LZ4 block of exactly `size` bytes. Reads call this per block,
 * so it takes and returns plain bytes.
 */
export function lz4_decompress_js(src: Uint8Array | number[], size: number): Uint8Array;

/**
 * Merge newest-first SST blobs into SSTs of about `target_bytes`, in key
 * order, with LZ4 blocks when `lz4` is set. `drop_tombstones` is for a
 * merge nothing older overlaps. Returns `{ssts, droppedSeq}`, where
 * droppedSeq is the highest seq of a dropped tombstone, 0 when none.
 */
export function merge_ssts_js(blobs: Array<any>, drop_tombstones: boolean, target_bytes: number, lz4: boolean): object;

/**
 * The puts of one data block, as the run's block index frames it, whose value
 * contains every pattern. `patterns` is each pattern as a little-endian u32
 * length then its bytes. Hits come back as `u32 key_len, u32 value_len, key,
 * value` records in key order.
 */
export function scan_block_contains_js(framed: Uint8Array | number[], lz4: boolean, patterns: Uint8Array | number[]): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly decode_sst_js: (a: any) => [number, number, number];
    readonly encode_sst_js: (a: any, b: number) => [number, number, number];
    readonly lz4_decompress_js: (a: number, b: number, c: number) => [number, number, number, number];
    readonly merge_ssts_js: (a: any, b: number, c: number, d: number) => [number, number, number];
    readonly scan_block_contains_js: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
