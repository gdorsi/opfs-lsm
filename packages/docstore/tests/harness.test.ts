import { expect, it } from "vitest";
import { openHarnessDb } from "@opfs-lsm/kv/testing";

it("opens a kv harness database on fake-indexeddb", async () => {
  const kv = await openHarnessDb({ name: "docstore-harness", forceMemory: true });
  await kv.put(Uint8Array.of(1), Uint8Array.of(2));
  expect(await kv.get(Uint8Array.of(1))).toEqual(Uint8Array.of(2));
  await kv.close();
});
