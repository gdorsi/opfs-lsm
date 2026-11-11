import { openDb } from "@opfs-lsm/kv";
import { kvCollectionOptions } from "@opfs-lsm/tanstack-db";
import { BTreeIndex, createCollection, createLiveQueryCollection, eq } from "@tanstack/db";
import { createFileRoute } from "@tanstack/react-router";
import { generate, type SeedComment, type SeedIssue } from "../../scripts/generate.ts";

type Search = { n: number; shape: "list" | "all"; run: string; seed: boolean };

export const Route = createFileRoute("/spike")({
  ssr: false,
  validateSearch: (s: Record<string, unknown>): Search => ({
    n: Number(s.n ?? 100000),
    shape: s.shape === "list" ? "list" : "all",
    run: String(s.run ?? "0"),
    seed: Number(s.seed) === 1,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const t0 = performance.now();
    const db = await openDb({ name: `spike-${deps.shape}-${deps.n}-${deps.run}` });
    const tOpen = performance.now();
    const issues = createCollection(
      kvCollectionOptions({ db, name: "issues", getKey: (i: Partial<SeedIssue> & { id: string }) => i.id }),
    );
    const comments = createCollection(
      kvCollectionOptions({ db, name: "comments", getKey: (c: SeedComment) => `${c.issue_id}/${c.id}` }),
    );
    issues.createIndex((i) => i.modified, { indexType: BTreeIndex });
    issues.createIndex((i) => i.status, { indexType: BTreeIndex });
    await Promise.all([issues.preload(), deps.shape === "all" ? comments.preload() : undefined]);
    const tLoaded = performance.now();
    let seeded = 0;
    let seedMs = 0;
    if (deps.seed && issues.size === 0) {
      const { issues: rows, comments: notes } = generate(deps.n);
      const s = performance.now();
      for (let i = 0; i < rows.length; i += 5000) {
        const chunk = rows.slice(i, i + 5000).map((r) => (deps.shape === "list" ? { ...r, description: undefined } : r));
        await issues.insert(chunk).when("settled");
      }
      if (deps.shape === "all")
        for (let i = 0; i < notes.length; i += 5000) await comments.insert(notes.slice(i, i + 5000)).when("settled");
      seedMs = performance.now() - s;
      seeded = rows.length;
    }
    const q0 = performance.now();
    const todo = createLiveQueryCollection((q) =>
      q
        .from({ i: issues })
        .where(({ i }) => eq(i.status, "todo"))
        .orderBy(({ i }) => i.modified, "desc")
        .limit(50),
    );
    await todo.preload();
    const q1 = performance.now();
    const result = {
      shape: deps.shape,
      n: deps.n,
      size: issues.size,
      comments: comments.size,
      seeded,
      seedMs: Math.round(seedMs),
      openMs: Math.round(tOpen - t0),
      loadMs: Math.round(tLoaded - tOpen),
      firstQueryMs: Math.round(q1 - q0),
      queryRows: todo.size,
      heapMB: Math.round(((performance as any).memory?.usedJSHeapSize ?? 0) / 1e6),
    };
    (globalThis as any).__spike = result;
    return result;
  },
  component: () => <pre id="spike">{JSON.stringify(Route.useLoaderData())}</pre>,
});
