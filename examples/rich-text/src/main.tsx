import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, type AppShutdown } from "./App";
import { openDocumentStore } from "./kv-document-store";

const rootEl = document.getElementById("root")!;

async function boot() {
  const params = new URLSearchParams(location.search);
  const dbName = params.get("name") ?? "rich-text";
  const docId = params.get("doc") ?? "default";

  const store = await openDocumentStore({ dbName, docId });
  const shutdown: AppShutdown = {
    flush: () => false,
  };

  window.addEventListener("beforeunload", () => {
    // A running save is left to finish; otherwise close ends this tab's log, so the SharedWorker reads it sooner.
    if (!shutdown.flush()) void store.close();
  });

  createRoot(rootEl).render(
    <StrictMode>
      <App store={store} shutdown={shutdown} />
    </StrictMode>,
  );
}

boot().catch((err) => {
  rootEl.textContent = err instanceof Error ? err.message : String(err);
  console.error(err);
});
