import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { FateClient } from "react-fate";
import { openFate, SessionContext } from "../client/fate.ts";
import { parseIssueFilter } from "../client/filter.ts";
import { keepAppOnDevice } from "../client/offline.ts";
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
    const opened = await openFate();
    keepAppOnDevice();
    return opened;
  },
  pendingMs: 200,
  pendingMinMs: 0,
  pendingComponent: () => <div className="splash">Opening local database…</div>,
  component: AppShell,
});

function AppShell() {
  const { fate, user, storage } = Route.useLoaderData();
  return (
    <FateClient client={fate}>
      <SessionContext value={{ user, storage }}>
        <Shell creating={Route.useSearch().new === 1} />
      </SessionContext>
    </FateClient>
  );
}
