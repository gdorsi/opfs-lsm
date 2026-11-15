import { Outlet, createFileRoute, retainSearchParams } from "@tanstack/react-router";
import { AppContext, openApp } from "../client/app.ts";

export const Route = createFileRoute("/_app")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => ({
    storage: search.storage === "idb" ? ("idb" as const) : undefined,
    db: typeof search.db === "string" && search.db ? search.db : undefined,
  }),
  // Every link keeps ?storage= and ?db=, so navigating never switches a tab's storage.
  search: { middlewares: [retainSearchParams(["storage", "db"])] },
  loader: () => openApp(),
  pendingMs: 200,
  pendingMinMs: 0,
  pendingComponent: () => <div className="splash">Opening local database…</div>,
  component: AppShell,
});

function AppShell() {
  return (
    <AppContext value={Route.useLoaderData()}>
      <Outlet />
    </AppContext>
  );
}
