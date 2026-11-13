import { Outlet, useLocation } from "@tanstack/react-router";
import { Loading } from "./boundary.tsx";
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
        <Loading fallback={<div className="loading">Loading…</div>}>
          <Outlet />
        </Loading>
      </main>
      {creating && <CreateModal filter={filter} onClose={modal.close} />}
    </div>
  );
}
