import { usePressure } from "../app/hooks.ts";
import { confirmEviction } from "../model/sync.ts";
import { Outlet, useLocation } from "@tanstack/react-router";
import { useState } from "react";
import { CreateModal } from "./create.tsx";
import { Check } from "./icons.tsx";
import { isTyping, useCreateModal, useGoBack, useIssueFilter, useKeys } from "./nav.ts";
import { Sidebar } from "./sidebar.tsx";

export function Shell({ creating }: { creating: boolean }) {
  const filter = useIssueFilter();
  const modal = useCreateModal();
  const goBack = useGoBack();
  const onIssue = useLocation({ select: (l) => l.pathname.startsWith("/issue/") });

  useKeys((e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const typing = isTyping(e.target);
    if (e.key === "Escape") {
      if (document.querySelector("[role=menu]")) return;
      if (creating) modal.close();
      else if (typing) (e.target as HTMLElement).blur();
      else if (onIssue) goBack();
    } else if (typing || creating) {
      return;
    } else if (e.key === "c") {
      e.preventDefault();
      modal.open();
    } else if (e.key === "/") {
      const search = document.getElementById("search");
      if (search) {
        e.preventDefault();
        search.focus();
      }
    }
  });

  return (
    <div className="app">
      <Sidebar onNew={modal.open} />
      <main className="main">
        <Outlet />
      </main>
      <StorageAlert />
      {creating && <CreateModal filter={filter} onClose={modal.close} />}
    </div>
  );
}

/**
 * Shown in every tab while storage pressure waits for a yes. The sync leader removes the cache and takes it down.
 * The button stays live after a click: a confirmation sent while no tab led the sync is lost, and a second one is harmless.
 */
function StorageAlert() {
  const { pending, unsent } = usePressure();
  const [confirmed, setConfirmed] = useState(false);
  if (!pending) {
    if (confirmed) setConfirmed(false);
    return null;
  }
  return (
    <div className="backdrop">
      <div className="modal storage" role="alertdialog" aria-labelledby="storage-title" aria-describedby="storage-text">
        <header>
          <span className="storage-badge" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <ellipse cx="9" cy="4.5" rx="6" ry="2.5" stroke="currentColor" strokeWidth="1.4" />
              <path d="M3 4.5v9c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-9M3 9c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </span>
          <div>
            <h2 id="storage-title">Storage is almost full</h2>
            <p>LinearLite needs to free space on this device.</p>
          </div>
        </header>
        <ul id="storage-text">
          <li><Check /> Cached descriptions and comments are removed</li>
          <li><Check /> They load again when you open an issue</li>
          <li><Check /> Nothing is lost on the server</li>
        </ul>
        {unsent > 0 && (
          <p className="storage-note">
            <strong>{unsent === 1 ? "1 unsent edit is sent first." : `${unsent} unsent edits are sent first.`}</strong> Removal starts once{" "}
            {unsent === 1 ? "it is" : "they are"} saved.
          </p>
        )}
        <button
          className="btn primary"
          autoFocus
          onClick={() => {
            setConfirmed(true);
            confirmEviction();
          }}
        >
          {!confirmed ? "Remove cached data" : unsent > 0 ? "Waiting for unsent edits…" : "Removing…"}
        </button>
      </div>
    </div>
  );
}
