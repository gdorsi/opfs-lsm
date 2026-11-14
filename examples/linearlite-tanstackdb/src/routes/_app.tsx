import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { openApp } from "../app/open.ts";
import { parseIssueFilter } from "../model/filter.ts";
import { Shell } from "../ui/shell.tsx";

const DEFAULTS = { status: [], priority: [], q: "", sort: "modified", dir: "desc" } as const;

export const Route = createFileRoute("/_app")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => ({
    ...parseIssueFilter(search),
    new: search.new === 1 || search.new === "1" ? (1 as const) : undefined,
  }),
  search: { middlewares: [stripSearchParams(DEFAULTS)] },
  loader: async () => void (await openApp()),
  pendingMs: 200,
  pendingComponent: () => <div className="splash">Opening local database…</div>,
  component: AppShell,
});

function AppShell() {
  return <Shell creating={Route.useSearch().new === 1} />;
}
