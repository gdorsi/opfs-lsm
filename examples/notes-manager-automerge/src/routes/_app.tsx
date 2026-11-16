import { createFileRoute, retainSearchParams } from "@tanstack/react-router";
import { AppContext, openApp } from "../client/app.ts";
import { keepAppOnDevice } from "../client/offline.ts";
import { Shell } from "../ui/shell.tsx";

export const Route = createFileRoute("/_app")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): { db?: string } => ({
    ...(typeof search.db === "string" && search.db && { db: search.db }),
  }),
  search: { middlewares: [retainSearchParams(["db"])] },
  loader: async () => {
    const app = await openApp();
    keepAppOnDevice();
    return app;
  },
  pendingMs: 200,
  pendingMinMs: 0,
  pendingComponent: () => <div className="splash">Opening local database…</div>,
  component: AppShell,
});

function AppShell() {
  const app = Route.useLoaderData();
  return (
    <AppContext value={app}>
      <Shell />
    </AppContext>
  );
}
