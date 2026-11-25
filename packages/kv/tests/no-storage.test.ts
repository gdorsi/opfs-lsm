import { describe, expect, it } from "vitest";
import {
  CorruptDatabaseError,
  noStorage,
  openDb,
  StorageFullError,
  StorageUnavailableError,
} from "../src/index.js";
import { errorOfCode } from "../src/errors.js";

describe("noStorage", () => {
  it("turns an open where this browser cannot store into undefined, as in Node", async () => {
    expect(await openDb({ name: "no-storage" }).catch(noStorage)).toBeUndefined();
  });

  it("gives undefined for an unavailable error, also one rebuilt from a port message", () => {
    expect(noStorage(new StorageUnavailableError("x"))).toBeUndefined();
    expect(noStorage(errorOfCode("unavailable", "x"))).toBeUndefined();
  });

  it("rethrows every other error as it is", () => {
    for (const error of [new StorageFullError("x"), new CorruptDatabaseError("x"), new Error("x"), "x"]) {
      let thrown: unknown;
      try {
        noStorage(error);
      } catch (caught) {
        thrown = caught;
      }
      expect(thrown).toBe(error);
    }
  });
});
