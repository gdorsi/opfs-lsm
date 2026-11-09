import {
  DocHandle,
  Repo,
  isValidAutomergeUrl,
  BroadcastChannelNetworkAdapter,
  RepoContext,
} from "@automerge/react"
import { openDb } from "@opfs-lsm/kv"

import React, { Suspense } from "react"
import { ErrorBoundary } from "react-error-boundary"
import ReactDOM from "react-dom/client"
import { App } from "./App.tsx"
import { kvStorage } from "@opfs-lsm/automerge"
import type { State } from "./types.ts"
import "./index.css"

declare global {
  interface Window {
    handle: DocHandle<unknown>
    repo: Repo
  }
}

const rootEl = document.getElementById("root") as HTMLElement

try {
  const name =
    new URLSearchParams(document.location.search).get("name") ?? "automerge-todo"
  const repo = new Repo({
    network: [new BroadcastChannelNetworkAdapter()],
    storage: kvStorage(await openDb({ name })),
  })

  const rootDocUrl = `${document.location.hash.substring(1)}`
  let handle
  if (isValidAutomergeUrl(rootDocUrl)) {
    handle = await repo.find(rootDocUrl)
  } else {
    handle = repo.create<State>({ todos: [] })
  }
  const docUrl = (document.location.hash = handle.url)
  window.handle = handle // we'll use this later for experimentation
  window.repo = repo

  ReactDOM.createRoot(rootEl).render(
    <RepoContext.Provider value={repo}>
      <React.StrictMode>
        <ErrorBoundary fallback={<div>Something went wrong</div>}>
          <Suspense fallback={<div>Loading...</div>}>
            <App url={docUrl} />
          </Suspense>
        </ErrorBoundary>
      </React.StrictMode>
    </RepoContext.Provider>
  )
} catch (err) {
  rootEl.textContent = err instanceof Error ? err.message : String(err)
}
