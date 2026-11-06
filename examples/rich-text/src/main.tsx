import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { openDocumentStore } from "./kv-document-store";

const rootEl = document.getElementById("root")!;

async function boot() {
  const params = new URLSearchParams(location.search);
  const dbName = params.get("name") ?? "rich-text";
  const docId = params.get("doc") ?? "default";

  const store = await openDocumentStore({ dbName, docId });

  window.addEventListener("beforeunload", () => {
    void store.close();
  });

  createRoot(rootEl).render(
    <StrictMode>
      <App store={store} />
    </StrictMode>,
  );
}

boot().catch((err) => {
  rootEl.textContent = err instanceof Error ? err.message : String(err);
  console.error(err);
});
