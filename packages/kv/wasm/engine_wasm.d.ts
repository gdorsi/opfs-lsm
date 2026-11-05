/* tslint:disable */
/* eslint-disable */

/**
 * Decode SST bytes to JS array of entries.
 */
export function decode_sst_js(buf: Uint8Array): Array<any>;

/**
 * Encode entries from JS: `[{kind:'put'|'del', key:Uint8Array, value?:Uint8Array, seq?:number}, ...]`
 */
export function encode_sst_js(entries: Array<any>): Uint8Array;

/**
 * Merge newest-first SST blobs into SSTs of about `target_bytes`, in key
 * order. `drop_tombstones` is for a merge nothing older overlaps. Returns
 * `{ssts, droppedSeq}`, where droppedSeq is the highest seq of a dropped
 * tombstone, 0 when none.
 */
export function merge_ssts_js(blobs: Array<any>, drop_tombstones: boolean, target_bytes: number): object;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly decode_sst_js: (a: any) => [number, number, number];
    readonly encode_sst_js: (a: any) => [number, number, number];
    readonly merge_ssts_js: (a: any, b: number, c: number) => [number, number, number];
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
