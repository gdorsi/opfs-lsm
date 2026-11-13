import { createHashHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, stripSearchParams } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_SEARCH, parseAppSearch } from "../src/client/filter.ts";
import { openedStore, openStore } from "../src/client/store.ts";
import "../src/ui/app.css";
import { BoardScreen } from "../src/ui/board.tsx";
import { DetailScreen } from "../src/ui/detail.tsx";
import { ListScreen } from "../src/ui/list.tsx";
import { Shell } from "../src/ui/shell.tsx";
import { demoState, failed, generateIssues, onDemoState, startBridge } from "./bridge.ts";
import { ensureDetail, markOffline } from "./data.ts";
import "./demo.css";

/**
 * LinearLite with no server, for a static host. The screens, the store and the queries are the app's own. The routes
 * are declared here instead of by TanStack Start, issues come from the seed instead of a first sync, and nothing
 * starts the sync leader, so the app stays as it is offline.
 */
const COUNT = Number(new URLSearchParams(location.search).get("count")) || 100_000;

const rootRoute = createRootRoute({ component: Outlet });

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_app",
  validateSearch: parseAppSearch,
  search: { middlewares: [stripSearchParams(DEFAULT_SEARCH)] },
  loader: async () => {
    const store = await openStore();
    const openedMs = performance.now();
    await markOffline(store);
    await startBridge(store, router, openedMs);
  },
  staleTime: Infinity,
  pendingMs: 200,
  pendingComponent: () => <div className="splash">Opening local database…</div>,
  onError: failed,
  errorComponent: ({ error }) => (
    <div className="empty">
      <div>
        <h2>The database did not open</h2>
        <p>{error instanceof Error ? error.message : String(error)}</p>
      </div>
    </div>
  ),
  component: () => <Shell creating={appRoute.useSearch().new === 1} />,
});

const listRoute = createRoute({ getParentRoute: () => appRoute, path: "/", component: List });
const boardRoute = createRoute({ getParentRoute: () => appRoute, path: "board", component: BoardScreen });
const issueRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "issue/$id",
  loader: ({ params }) => ensureDetail(openedStore(), params.id),
  component: () => <DetailScreen id={issueRoute.useParams().id} />,
});

const router = createRouter({
  routeTree: rootRoute.addChildren([appRoute.addChildren([listRoute, boardRoute, issueRoute])]),
  history: createHashHistory(),
  scrollRestoration: false,
});

function List() {
  const { hasIssues, generating } = useSyncExternalStore(onDemoState, demoState);
  if (hasIssues && !generating) return <ListScreen />;
  const n = COUNT.toLocaleString("en-US");
  return (
    <div className="empty" id="demo-empty">
      {generating ? (
        <div className="demo-progress" role="status">
          <h2>{generating.phase === "generating" ? `Generating ${n} issues` : `Writing ${n} issues`}</h2>
          <p className="mono">
            {generating.written.toLocaleString("en-US")} of {n}
          </p>
          <div className="bar">
            <i style={{ width: `${(100 * generating.written) / generating.total}%` }} />
          </div>
        </div>
      ) : (
        <div>
          <h2>No issues yet</h2>
          <p>This LinearLite has no server. It generates its issues in this page and keeps them in your browser.</p>
          <button className="btn primary" id="demo-generate" onClick={() => void generateIssues(openedStore(), COUNT)}>
            Generate {n} issues
          </button>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
