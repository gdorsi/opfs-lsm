import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { FateClient } from "react-fate";
import { openedFate, openFate } from "../client/fate.ts";
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
    await openFate();
    keepAppOnDevice();
  },
  pendingMs: 200,
  pendingMinMs: 0,
  pendingComponent: () => <div className="splash">Opening local database…</div>,
  component: AppShell,
});

function AppShell() {
  return (
    <FateClient client={openedFate().fate}>
      <Shell creating={Route.useSearch().new === 1} />
    </FateClient>
  );
}
