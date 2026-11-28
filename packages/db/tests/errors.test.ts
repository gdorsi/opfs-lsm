import { DocStoreError } from "@opfs-lsm/docstore";
import { ClosedError as KvClosed, CommitError, ConstraintError, CorruptDatabaseError, StorageFullError, StorageUnavailableError } from "@opfs-lsm/kv";
import { describe, expect, it } from "vitest";
import { ClosedError, ConflictError, DbError, NotFoundError, QueryError, SchemaError, StorageError, ValidationError, wrap, type AnyDbError } from "../src/errors.js";

const tagAndCode = (err: unknown) => (err instanceof DbError ? `${err._tag} ${err.code}` : "not a DbError");

describe("wrap", () => {
  it("gives each storage error a tag and a code", () => {
    const cases: [unknown, string][] = [
      [new KvClosed("closed"), "ClosedError closed"],
      [new CommitError("lost"), "StorageError commit"],
      [new StorageFullError("full"), "StorageError quota"],
      [new StorageUnavailableError("no opfs"), "StorageError unavailable"],
      [new CorruptDatabaseError("bad"), "StorageError corrupt"],
      [new ConstraintError("too large"), "StorageError limit"],
      [new DocStoreError("unique", "taken", ["b", "a"]), "ConflictError unique"],
      [new DocStoreError("document", "an index cannot hold the value"), "ValidationError indexed-field"],
      [new DocStoreError("version", "stored with other indexes"), "SchemaError version"],
      [new DocStoreError("schema", "the stored catalog has no collection"), "SchemaError catalog"],
      [new DocStoreError("index-failed", "cannot hold the stored data", ["a"]), "StorageError index-failed"],
    ];
    for (const [err, expected] of cases) expect(tagAndCode(wrap(err, "issues"))).toBe(expected);
  });

  it("keeps the storage's error as the cause, and the ids of a unique conflict", () => {
    const full = new StorageFullError("full");
    expect((wrap(full) as StorageError).cause).toBe(full);
    const conflict = wrap(new DocStoreError("unique", "taken", ["b", "a"]), "users") as ConflictError;
    expect(conflict.ids).toEqual(["b", "a"]);
    expect(conflict.collection).toBe("users");
  });

  it("gives a unique conflict no ids when the storage names none", () => {
    expect((wrap(new DocStoreError("unique", "taken"), "users") as ConflictError).ids).toEqual([]);
  });

  it("passes through a DbError, an error of the app, and a docstore error only a bug of this library can cause", () => {
    const own = new NotFoundError("issues", "i1");
    const app = new TypeError("from a callback");
    const bug = new DocStoreError("query", "gt and gte together");
    expect(wrap(own)).toBe(own);
    expect(wrap(app)).toBe(app);
    expect(wrap(bug)).toBe(bug);
  });
});

it("every error class has its own fixed _tag and is a DbError", () => {
  const errors = [
    new ValidationError("invalid", "m", "c", "i"),
    new ConflictError("duplicate", "m", "c", ["i"]),
    new NotFoundError("c", "i"),
    new QueryError("operand", "m"),
    new SchemaError("version", "m"),
    new ClosedError("destroyed"),
    new StorageError("quota", "m", { cause: undefined }),
  ];
  expect(errors.map((e) => e._tag)).toEqual(errors.map((e) => e.constructor.name));
  expect(errors.map((e) => e.name)).toEqual(errors.map((e) => e._tag));
  expect(errors.every((e) => e instanceof DbError && e instanceof Error)).toBe(true);
});

/** Never called: the compiler checks that a tag narrows the union to its class. */
export function types(error: AnyDbError): unknown {
  switch (error._tag) {
    case "NotFoundError":
      return error.id satisfies string;
    case "ConflictError":
      return error.ids satisfies readonly string[];
    case "StorageError":
      return error.code satisfies "commit" | "quota" | "unavailable" | "corrupt" | "limit" | "index-failed";
    default:
      // @ts-expect-error only a NotFoundError names one id
      return error.id;
  }
}
