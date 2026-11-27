import { destroyDb } from "@opfs-lsm/kv";
import { ensureEngine } from "@opfs-lsm/kv/testing";
import { render } from "@solidjs/web";
import { createEffect, createMemo, createSignal, Errored, from, onSettled, Show } from "solid-js";
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
const DATA_VERSION = 12;

const params = new URLSearchParams(location.search);
const NAME = params.get("db") ?? `linearlite-docstore-v${DATA_VERSION}`;
const COUNT = Number(params.get("count")) || 100_000;
// `theme=dark` keeps the dark look on a light system, for a page that embeds the app on a dark background.
if (params.get("theme") === "dark") document.documentElement.dataset.theme = "dark";
const n = (x: number) => x.toLocaleString("en-US");

const width = (g: NonNullable<AppState["generating"]>) => `${(g.written / g.count) * 100}%`;

const Frame = () => <div class="topbar" />;

/** The page. Until the database is open there is no `app`, and the page shows its frame only. */
function Page(props: { app: App | undefined }) {
  return (
    <div class="app">
      <main class="main">
        <Show when={props.app} fallback={<Frame />}>
          {(app) => (
            <Errored fallback={(error) => <Failed error={error()} />}>
              <Issues app={app()} />
            </Errored>
          )}
        </Show>
      </main>
    </div>
  );
}

function Failed(props: { error: unknown }) {
  createEffect(() => props.error, failed);
  return <Frame />;
}

function Issues(props: { app: App }) {
  const state = createMemo(() => from(props.app.subscribe));
  const [composing, setComposing] = createSignal(false);
  const [createMore, setCreateMore] = createSignal(false);
  const generate = () => void props.app.generate(COUNT).catch(failed);
  const data: Item[] = [
    { label: () => <span>Generate {n(COUNT)} more</span>, on: false, pick: generate },
    { label: () => <span>Delete the data</span>, on: false, pick: () => props.app.destroy() },
  ];

  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !composing()) props.app.close();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  return (
    <>
      <Toolbar
        filter={state().filter}
        total={state().total}
        data={data}
        progress={state().generating && !state().empty ? width(state().generating!) : undefined}
        set={(patch) => props.app.filter(patch)}
        create={() => setComposing(true)}
      />
      <Show when={state().empty} fallback={<IssueList app={props.app} />}>
        <div class="empty">
          <Show
            when={state().generating}
            fallback={
              <div id="start">
                <h2>No issues yet</h2>
                <p>They are generated in a dedicated WebWorker and stored in this browser.</p>
                <button class="btn primary" id="demo-generate" onClick={generate}>
                  Generate {n(COUNT)} issues
                </button>
              </div>
            }
          >
            {(generating) => (
              <div class="demo-progress">
                <h2>Writing issues</h2>
                <p class="mono">
                  {n(generating().written)} of {n(generating().count)}
                </p>
                <div class="bar">
                  <i style={{ width: width(generating()) }} />
                </div>
              </div>
            )}
          </Show>
        </div>
      </Show>
      <Show when={state().issue}>{(issue) => <Detail app={props.app} issue={issue()} detail={state().detail} />}</Show>
      <Show when={composing()}>
        <Compose create={(draft) => props.app.create(draft)} close={() => setComposing(false)} more={createMore()} setMore={setCreateMore} />
      </Show>
    </>
  );
}

async function main() {
  const [opened, setOpened] = createSignal<App>();
  render(() => <Page app={opened()} />, document.getElementById("root")!);
  // The wasm module is fetched and compiled before the clock starts, so network time stays out of the open time.
  await ensureEngine();
  const t0 = performance.now();
  const store = await openStore(NAME);
  const openedMs = performance.now() - t0;
  const app = createApp(store);
  setOpened(app);

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
 * `DATA_VERSION`. Removed in the background, so a visitor of an earlier build gets the space back. `destroyDb` on a
 * name with nothing stored creates nothing, so it runs on every load.
 */
const RETIRED = [
  "opfs-lsm-home",
  "linearlite-docstore",
  ...Array.from({ length: DATA_VERSION - 1 }, (_, i) => `linearlite-docstore-v${i + 1}`),
].filter((name) => name !== NAME);

async function dropRetired(): Promise<void> {
  for (const name of RETIRED) await destroyDb(name).catch(() => undefined);
}

main().catch(failed);
