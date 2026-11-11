import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { createLiveQueryCollection, eq } from "@tanstack/db";
import * as commands from "../client/commands.ts";
import { parseIssueFilter } from "../client/filter.ts";
import { openStore } from "../client/store.ts";
import { fetchDetail, startSync } from "../client/sync.ts";
import { Shell } from "../ui/shell.tsx";

const DEFAULTS = { status: [], priority: [], q: "", sort: "modified", dir: "desc" } as const;

/** Every screen: opens the local database, starts sync and carries the filter and the `?new=1` dialog in the URL. */
export const Route = createFileRoute("/_app")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => ({
    ...parseIssueFilter(search),
    new: search.new === 1 || search.new === "1" ? (1 as const) : undefined,
  }),
  search: { middlewares: [stripSearchParams(DEFAULTS)] },
  loader: async () => {
    const store = await openStore();
    startSync(store);
    if (import.meta.env.DEV) Object.assign(globalThis, { __linearlite: { store, commands, fetchDetail, createLiveQueryCollection, eq } });
  },
  pendingMs: 200,
  pendingComponent: () => <div className="splash">Opening local database…</div>,
  component: AppShell,
});

function AppShell() {
  return <Shell creating={Route.useSearch().new === 1} />;
}
