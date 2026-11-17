import { destroyDb } from "@opfs-lsm/kv";
import { ensureEngine } from "@opfs-lsm/kv/testing";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { createApp, type App, type AppState } from "./app.ts";
import "./app.css";
import { Compose } from "./compose.tsx";
import { Detail } from "./detail.tsx";
import { IssueList } from "./issues.tsx";
import type { Item } from "./menu.tsx";
import { SOURCE, failed, post, type ToDemo } from "./protocol.ts";
import { openStore } from "./store.ts";
import { Toolbar } from "./toolbar.tsx";

/**
 * The version of the data this app stores, in its database name. Raise it in any change that makes data written before
 * it read differently: a kv or docstore format, or this app's schema. A visitor then starts on a fresh database, and
 * the app frees the old one.
 */
const DATA_VERSION = 1;

const params = new URLSearchParams(location.search);
const NAME = params.get("db") ?? `linearlite-docstore-v${DATA_VERSION}`;
const COUNT = Number(params.get("count")) || 100_000;
const n = (x: number) => x.toLocaleString("en-US");

const width = (g: AppState["generating"]) => `${g?.phase === "writing" ? (g.written / g.count) * 100 : 0}%`;

/** The page. Until the database is open there is no `app`, and the page shows its frame only. */
function Page({ app }: { app: App | undefined }) {
  return (
    <div className="app">
      <main className="main">{app ? <Issues app={app} /> : <div className="topbar" />}</main>
    </div>
  );
}

const useAppState = (app: App) => useSyncExternalStore(app.subscribe, app.state);

function Issues({ app }: { app: App }) {
  const { empty, generating, filter, total, issue, detail } = useAppState(app);
  const [composing, setComposing] = useState(false);
  const close = useCallback(() => setComposing(false), []);
  const generate = () => void app.generate(COUNT).catch(failed);
  const data: Item[] = [
    { label: <span>Generate {n(COUNT)} more</span>, on: false, pick: generate },
    { label: <span>Delete the data</span>, on: false, pick: app.destroy },
  ];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !composing) app.close();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [app, composing]);

  return (
    <>
      <Toolbar
        filter={filter}
        total={total}
        data={data}
        progress={generating && !generating.first ? width(generating) : undefined}
        set={app.filter}
        create={() => setComposing(true)}
      />
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
              <button className="btn primary" id="demo-generate" onClick={generate}>
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
  if (rows > 0) post({ type: "first-rows", ms: at - t0 });
  void dropRetired();
}

/**
 * The databases earlier builds stored their issues in: the TanStack DB demo's, the unversioned one, and every lower
 * `DATA_VERSION`. Removed in the background, so a visitor of an earlier build gets the space back.
 */
const RETIRED = [
  "opfs-lsm-home",
  "linearlite-docstore",
  ...Array.from({ length: DATA_VERSION - 1 }, (_, i) => `linearlite-docstore-v${i + 1}`),
].filter((name) => name !== NAME);

async function dropRetired(): Promise<void> {
  const lsm = await navigator.storage
    .getDirectory()
    .then((root) => root.getDirectoryHandle("opfs-lsm"))
    .catch(() => undefined);
  if (!lsm) return;
  for (const name of RETIRED) {
    const stored = await lsm.getDirectoryHandle(name).then(() => true, () => false);
    if (stored) await destroyDb(name).catch(() => undefined);
  }
}

main().catch(failed);
