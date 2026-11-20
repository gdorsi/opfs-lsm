import { vi } from "vitest";

/**
 * Sizes of the group commits that committed since the call, in commit order:
 * how many records each WAL transaction of `append` held. An `update` writes
 * its record under an explicit key and is not a group.
 */
export function watchWalGroups(): number[] {
  const sizes: number[] = [];
  const open = new Map<IDBTransaction, number>();
  const add = IDBObjectStore.prototype.add;
  vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "wal" && args.length === 1) {
      const tx = this.transaction;
      if (!open.has(tx)) tx.addEventListener("complete", () => sizes.push(open.get(tx)!));
      open.set(tx, (open.get(tx) ?? 0) + 1);
    }
    return add.apply(this, args);
  });
  return sizes;
}
