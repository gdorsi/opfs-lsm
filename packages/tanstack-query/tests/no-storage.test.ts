/** TanStack throws in development where a persister has no storage to iterate, so these tests run as development. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { QueryClient } from "@tanstack/query-core";
import { noStorage, openDb } from "@opfs-lsm/kv";
import { createQueryPersister } from "../src/index.ts";

const db = await openDb({ name: "tanstack-query-no-storage" }).catch(noStorage);

const nodeEnv = process.env.NODE_ENV;
const rejections: unknown[] = [];
const onRejection = (reason: unknown) => rejections.push(reason);
before(() => {
  process.env.NODE_ENV = "development";
  process.on("unhandledRejection", onRejection);
});
after(() => {
  process.env.NODE_ENV = nodeEnv;
  process.off("unhandledRejection", onRejection);
});

// An infinite gcTime schedules no timer, so a test leaves no handle open.
const newClient = () => new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });

test("the open gives no db in Node", () => {
  assert.equal(db, undefined);
});

test("a query runs its queryFn each time, and nothing is restored", async () => {
  const persister = createQueryPersister(db);
  const queryKey = ["todo", 1];
  let calls = 0;
  const fetch = (client: QueryClient) =>
    client.fetchQuery({
      queryKey,
      queryFn: () => ({ id: 1, call: ++calls }),
      persister: persister.persisterFn,
    });

  const client = newClient();
  assert.deepEqual(await fetch(client), { id: 1, call: 1 });
  client.clear();
  assert.deepEqual(await fetch(client), { id: 1, call: 2 });
  assert.deepEqual(await fetch(newClient()), { id: 1, call: 3 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(rejections, []);
});

test("persisting, restoring, removing and collecting resolve and keep nothing", async () => {
  const persister = createQueryPersister(db);
  const client = newClient();
  client.setQueryData(["todos"], ["one"]);
  await persister.persistQueryByKey(["todos"], client);

  const fresh = newClient();
  await persister.restoreQueries(fresh);
  assert.equal(fresh.getQueryData(["todos"]), undefined);
  assert.equal(await persister.retrieveQuery("todos"), undefined);
  await persister.removeQueries();
  await persister.persisterGc();
  assert.deepEqual(rejections, []);
});
