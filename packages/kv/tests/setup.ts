import "fake-indexeddb/auto";
import { expect } from "vitest";

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
