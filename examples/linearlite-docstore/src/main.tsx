import { destroyDb } from "@opfs-lsm/kv";
import { ensureEngine } from "@opfs-lsm/kv/testing";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { createApp, type App, type AppState } from "./app.ts";
import "./app.css";
import { Compose } from "./compose.tsx";
import { Detail } from "./detail.tsx";
import { IssueList } from "./issues.tsx";
import { SOURCE, failed, post, type ToDemo } from "./protocol.ts";
import { hostOf, openStore } from "./store.ts";
import { Toolbar } from "./toolbar.tsx";

const params = new URLSearchParams(location.search);
const NAME = params.get("db") ?? "linearlite-docstore";
const COUNT = Number(params.get("count")) || 100_000;
const n = (x: number) => x.toLocaleString("en-US");

const width = (g: AppState["generating"]) => `${g?.phase === "writing" ? (g.written / g.count) * 100 : 0}%`;

/** The page. Until the database is open there is no `app`, and the page shows its frame only. */
function Page({ app }: { app: App | undefined }) {
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">L</span>LinearLite
        </div>
        <span className="nav active">All issues</span>
        <div className="spacer" />
        {app && <Sync app={app} />}
      </aside>
      <main className="main">{app ? <Issues app={app} /> : <div className="topbar" />}</main>
    </div>
  );
}

const useAppState = (app: App) => useSyncExternalStore(app.subscribe, app.state);

function Sync({ app }: { app: App }) {
  const { generating } = useAppState(app);
  return (
    <div className="sync">
      <b>Local only</b>
      <button className="btn" id="more" onClick={() => void app.generate(COUNT).catch(failed)}>
        Generate {n(COUNT)} more
      </button>
      {generating && !generating.first && (
        <div className="bar" id="more-bar">
          <i style={{ width: width(generating) }} />
        </div>
      )}
      <button className="btn" id="delete" onClick={app.destroy}>
        Delete the data
      </button>
    </div>
  );
}

function Issues({ app }: { app: App }) {
  const { empty, generating, filter, total, issue, detail } = useAppState(app);
  const [composing, setComposing] = useState(false);
  const close = useCallback(() => setComposing(false), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !composing) app.close();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [app, composing]);

  return (
    <>
      <Toolbar filter={filter} total={total} set={app.filter} create={() => setComposing(true)} />
      {empty ? (
        <div className="empty">
          {generating ? (
            <div className="demo-progress">
              <h2>{generating.phase === "generating" ? "Generating issues" : "Writing issues"}</h2>
              <p className="mono">
                {n(generating.written)} of {n(generating.count)}
              </p>
              <div className="bar">
                <i style={{ width: width(generating) }} />
              </div>
            </div>
          ) : (
            <div id="start">
              <h2>No issues yet</h2>
              <p>They are generated in a dedicated WebWorker and stored in this browser.</p>
              <button className="btn primary" id="demo-generate" onClick={() => void app.generate(COUNT).catch(failed)}>
                Generate {n(COUNT)} issues
              </button>
            </div>
          )}
        </div>
      ) : (
        <IssueList app={app} />
      )}
      {issue && <Detail key={issue.id} app={app} issue={issue} detail={detail} />}
      {composing && <Compose create={app.create} close={close} />}
    </>
  );
}

async function main() {
  const root = createRoot(document.getElementById("root")!);
  root.render(<Page app={undefined} />);
  // The wasm module is fetched and compiled before the clock starts, so network time stays out of the open time.
  await ensureEngine();
  const t0 = performance.now();
  const store = await openStore(NAME);
  const openedMs = performance.now() - t0;
  const app = createApp(store);
  root.render(<Page app={app} />);

  addEventListener("message", (e: MessageEvent<ToDemo & { source?: string }>) => {
    if (e.origin !== location.origin || e.data?.source !== SOURCE) return;
    if (e.data.type === "generate") void app.generate(e.data.count).catch(failed);
    else if (e.data.type === "delete") app.destroy();
  });

  const { rows, at } = await app.start();
  post({ type: "opened", ms: openedMs, issues: rows });
  if (rows > 0) post({ type: "first-rows", ms: at - t0, host: await hostOf(store) });
  void dropRetired();
}

/**
 * The docs home page's earlier demo, the TanStack DB build of LinearLite, kept its issues in a database of this name
 * with another schema. Removed in the background, once, so a visitor of that version gets the space back.
 */
const RETIRED = "opfs-lsm-home";

async function dropRetired(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await (await root.getDirectoryHandle("opfs-lsm")).getDirectoryHandle(RETIRED);
  } catch {
    return;
  }
  await destroyDb(RETIRED).catch(() => undefined);
}

main().catch(failed);
