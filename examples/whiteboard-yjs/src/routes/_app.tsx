import { Outlet, createFileRoute, retainSearchParams } from "@tanstack/react-router";
import { openSession } from "../app/session.ts";
import { MessagePage, Splash } from "../app/ui.tsx";

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
  pendingComponent: () => <Splash>Opening local database…</Splash>,
  errorComponent: ({ error }) => (
    <MessagePage
      title="Can’t open local storage"
      alert
      action={
        <button type="button" className="btn primary" onClick={() => location.reload()}>
          Try again
        </button>
      }
    >
      <p>The browser refused the database this app keeps its boards in.</p>
      <p className="message-detail">{String(error)}</p>
    </MessagePage>
  ),
  component: Outlet,
});
