import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { expect, test } from "vitest";

test("two handles on one kv name see each other's writes", async () => {
  const a = await openHarnessDb({ name: "spaces-smoke", forceMemory: true });
  const b = await openHarnessDb({ name: "spaces-smoke", forceMemory: true });
  await a.put(new Uint8Array([0x73, 1]), new Uint8Array([7]));
  await b.sync();
  expect(await b.get(new Uint8Array([0x73, 1]))).toEqual(new Uint8Array([7]));
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  expect(keys).toBeTruthy();
  await a.close();
  await b.close();
});
