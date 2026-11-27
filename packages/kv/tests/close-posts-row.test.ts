import { afterEach, expect, it, vi } from "vitest";
import { __resetMemoryFsForTests, destroyHarnessDb, openHarnessDb, type ChangeEvent } from "../src/testing.js";

const NAME = "close-posts-row";
const enc = new TextEncoder();
const b = (s: string) => enc.encode(s);

afterEach(async () => {
  await destroyHarnessDb({ name: NAME, forceMemory: true });
  __resetMemoryFsForTests(NAME);
});

it("a write acked by a handle that closes right after reaches another tab without a sync", async () => {
  const reader = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "reader" });
  const writer = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "writer" });
  const seen: ChangeEvent[] = [];
  reader.changes((event) => seen.push(event));

  const put = writer.put(b("k"), b("v"));
  const closed = writer.close();
  const seq = await put;
  await closed;

  await vi.waitFor(() => expect(seen.filter((e) => e.kind === "append").map((e) => (e as { seq: number }).seq)).toEqual([seq]));
  expect(await reader.get(b("k"))).toEqual(b("v"));
  await reader.close();
});

it("control: a write acked before its handle closes reaches another tab without a sync", async () => {
  const reader = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "reader" });
  const writer = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "writer" });
  const seen: ChangeEvent[] = [];
  reader.changes((event) => seen.push(event));

  const seq = await writer.put(b("k"), b("v"));
  await writer.close();

  await vi.waitFor(() => expect(seen.filter((e) => e.kind === "append").map((e) => (e as { seq: number }).seq)).toEqual([seq]));
  expect(await reader.get(b("k"))).toEqual(b("v"));
  await reader.close();
});
