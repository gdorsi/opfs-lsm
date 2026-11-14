import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FilterArgs } from "../domain/model.ts";
import { placeNewIssue, type Shown } from "./place.ts";

const everything: FilterArgs = { status: [], priority: [], q: "" };
const column = { name: "column" } as never;
const list = { name: "list" } as never;

function screen(columnFilter: FilterArgs | undefined, listFilter: FilterArgs | undefined, top: string | null = "a0"): Shown {
  return {
    ...(columnFilter && { column: { filter: columnFilter, target: column, top } }),
    ...(listFilter && { list: { filter: listFilter, target: list } }),
  };
}

const low = { status: 1, priority: 1, title: "Tidy the sync engine" } as const;

describe("placeNewIssue", () => {
  it("tops an unfiltered column and sends that order to the server", () => {
    const place = placeNewIssue(screen(everything, everything), low);
    assert.deepEqual(place.into, [column, list]);
    assert.ok(place.shownOrder !== undefined && place.shownOrder < "a0");
    assert.equal(place.sentOrder, place.shownOrder);
  });

  it("starts an empty column", () => {
    const place = placeNewIssue(screen(everything, undefined, null), low);
    assert.deepEqual(place.into, [column]);
    assert.ok(place.sentOrder !== undefined);
  });

  it("keeps the issue out of a column whose priority or text filter does not list it", () => {
    for (const filter of [{ ...everything, priority: [4] }, { ...everything, q: "kanban" }] as FilterArgs[]) {
      assert.deepEqual(placeNewIssue(screen(filter, filter), low), { into: [] }, JSON.stringify(filter));
    }
  });

  it("shows the issue in a filtered column that lists it, and leaves the order to the server", () => {
    const place = placeNewIssue(screen({ ...everything, priority: [1], q: "SYNC" }, undefined), low);
    assert.deepEqual(place.into, [column]);
    assert.ok(place.shownOrder !== undefined && place.shownOrder < "a0");
    assert.equal(place.sentOrder, undefined);
  });

  it("names nothing when the issue's column is not cached", () => {
    assert.deepEqual(placeNewIssue(screen(undefined, undefined), low), { into: [] });
  });
});
