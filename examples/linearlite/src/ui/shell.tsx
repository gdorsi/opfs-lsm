import { usePressure } from "../client/hooks.ts";
import { confirmEviction } from "../client/sync.ts";
import { Outlet, useLocation } from "@tanstack/react-router";
import { CreateModal } from "./create.tsx";
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
      {usePressure() && (
        <div className="backdrop">
          <div className="modal" role="alertdialog" aria-labelledby="storage-title" aria-describedby="storage-text">
            <h2 id="storage-title">Storage is almost full</h2>
            <p id="storage-text">
              Cached descriptions and comments will be removed from this device. They load again when needed, and nothing is lost on the server.
            </p>
            <div className="modal-foot">
              <span className="spacer" />
              <button className="btn primary" autoFocus onClick={confirmEviction}>
                Remove cached data
              </button>
            </div>
          </div>
        </div>
      )}
      {creating && <CreateModal filter={filter} onClose={modal.close} />}
    </div>
  );
}
