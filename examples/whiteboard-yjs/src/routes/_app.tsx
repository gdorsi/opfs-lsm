import { Outlet, createFileRoute, retainSearchParams } from "@tanstack/react-router";
import { openSession } from "../app/session.ts";

type AppSearch = { storage?: "idb"; db?: string; fault?: 1 };

export const Route = createFileRoute("/_app")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): AppSearch => ({
    storage: search.storage === "idb" ? "idb" : undefined,
    db: typeof search.db === "string" && search.db !== "" ? search.db : undefined,
    fault: search.fault === 1 || search.fault === "1" ? 1 : undefined,
  }),
  search: { middlewares: [retainSearchParams(["storage", "db", "fault"])] },
  loader: () => openSession(),
  pendingMs: 200,
  pendingMinMs: 0,
  pendingComponent: () => <div className="splash">Opening local database…</div>,
  errorComponent: ({ error }) => (
    <div className="splash" role="alert">
      Could not open local storage: {String(error)}
    </div>
  ),
  component: Outlet,
});
