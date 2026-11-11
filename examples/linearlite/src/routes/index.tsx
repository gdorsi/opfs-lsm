import { openDb } from "@opfs-lsm/kv";
import { kvCollectionOptions } from "@opfs-lsm/tanstack-db";
import { createCollection } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

const sqliteVersion = createServerFn().handler(async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  return (db.prepare("select sqlite_version() as v").get() as { v: string }).v;
});

type Smoke = { id: string; at: number };

export const Route = createFileRoute("/")({
  ssr: false,
  loader: async () => {
    const db = await openDb({ name: "linearlite-smoke" });
    const smoke = createCollection(kvCollectionOptions({ db, name: "smoke", getKey: (r: Smoke) => r.id }));
    await smoke.preload();
    return { smoke, sqlite: await sqliteVersion() };
  },
  component: Smoke,
});

function Smoke() {
  const { smoke, sqlite } = Route.useLoaderData();
  const { data } = useLiveQuery((q) => q.from({ s: smoke }), [smoke]);
  return (
    <main>
      <p id="sqlite">sqlite {sqlite}</p>
      <p id="rows">rows {data.length}</p>
      <button onClick={() => smoke.insert({ id: crypto.randomUUID(), at: Date.now() })}>add</button>
    </main>
  );
}
