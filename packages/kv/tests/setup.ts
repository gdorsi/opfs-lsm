import "fake-indexeddb/auto";
import "../src/testing.js";
import { expect } from "vitest";
import { useLz4Decoder } from "../src/store/lz4.js";
import { lz4DecompressJs } from "./oracle/lz4-js.js";

// A test that reads a run without opening a database has no wasm decoder yet.
useLz4Decoder(lz4DecompressJs);

// `toEqual` walks a Uint8Array as a generic object, and the sims compare
// thousands of keys and values per history. Two arrays of the same class are
// equal when their bytes are; anything else falls through to the default.
expect.addEqualityTesters([
  (a: unknown, b: unknown): boolean | undefined => {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return undefined;
    if (a.constructor !== b.constructor) return undefined;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  },
]);
