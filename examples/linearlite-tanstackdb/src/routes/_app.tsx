import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { createLiveQueryCollection, eq } from "@tanstack/db";
import * as commands from "../model/commands.ts";
import { parseIssueFilter } from "../model/filter.ts";
import { openStore } from "../model/store.ts";
import { fetchDetail, startSync } from "../model/sync.ts";
import { Shell } from "../ui/shell.tsx";

const DEFAULTS = { status: [], priority: [], q: "", sort: "modified", dir: "desc" } as const;

export const Route = createFileRoute("/_app")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => ({
    ...parseIssueFilter(search),
    new: search.new === 1 || search.new === "1" ? (1 as const) : undefined,
  }),
  search: { middlewares: [stripSearchParams(DEFAULTS)] },
  loader: async () => {
    const store = await openStore();
    startSync(store, Number(new URLSearchParams(location.search).get("pull")) || undefined);
    // bench/client.ts drives edits through this, on production builds too.
    Object.assign(globalThis, { __linearlite: { store, commands, fetchDetail, createLiveQueryCollection, eq } });
  },
  pendingMs: 200,
  pendingComponent: () => <div className="splash">Opening local database…</div>,
  component: AppShell,
});

function AppShell() {
  return <Shell creating={Route.useSearch().new === 1} />;
}
