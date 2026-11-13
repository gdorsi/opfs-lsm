import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { createLiveQueryCollection, eq } from "@tanstack/db";
import * as commands from "../client/commands.ts";
import { DEFAULT_SEARCH, parseAppSearch } from "../client/filter.ts";
import { openStore } from "../client/store.ts";
import { fetchDetail, startSync } from "../client/sync.ts";
import { Shell } from "../ui/shell.tsx";

export const Route = createFileRoute("/_app")({
  ssr: false,
  validateSearch: parseAppSearch,
  search: { middlewares: [stripSearchParams(DEFAULT_SEARCH)] },
  loader: async () => {
    const store = await openStore();
    startSync(store);
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
