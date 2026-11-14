import { Link } from "@tanstack/react-router";
import { keepSearch } from "./nav.ts";
import { useSyncStatus } from "../app/hooks.ts";
import type { SyncStatus } from "../model/sync.ts";

export function Sidebar({ onNew }: { onNew(): void }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">L</span>LinearLite
      </div>
      <button className="new-btn" onClick={onNew}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
          <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        New issue <kbd>C</kbd>
      </button>
      <Link to="/" search={keepSearch} className="nav" activeProps={{ className: "nav active" }} activeOptions={{ exact: true }}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
          <path d="M2 3.5h10M2 7h10M2 10.5h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        All issues
      </Link>
      <Link to="/board" search={keepSearch} className="nav" activeProps={{ className: "nav active" }}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
          <rect x="2" y="2.5" width="3.2" height="9" rx="1" stroke="currentColor" strokeWidth="1.4" />
          <rect x="8.8" y="2.5" width="3.2" height="6" rx="1" stroke="currentColor" strokeWidth="1.4" />
        </svg>
        Board
      </Link>
      <div className="spacer" />
      <SyncFooter />
    </aside>
  );
}

const NAMES = { issues: "issues", bodies: "descriptions", comments: "comments" } as const;
const n = (x: number) => x.toLocaleString("en-US");

function SyncFooter() {
  const status = useSyncStatus();
  const view = describe(status);
  if (!view) return <div className="sync" />;
  return (
    <div className={`sync ${status.kind === "offline" ? "sync-offline" : status.kind === "syncing" ? "sync-live" : ""}`} id="sync" role="status">
      <b>{view.text}</b>
      {view.detail && <span className="mono">{view.detail}</span>}
      {view.progress !== undefined && (
        <div className="bar">
          <i style={{ width: `${Math.min(100, view.progress * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

function describe(status: SyncStatus): { text: string; detail?: string; progress?: number } | undefined {
  const unsynced = status.unsynced > 0 ? ` · ${n(status.unsynced)} unsynced` : "";
  switch (status.kind) {
    case "starting":
      return status.unsynced > 0 ? { text: `Connecting${unsynced}` } : undefined;
    case "offline":
      return { text: `Offline${unsynced}` };
    case "syncing":
      return { text: `Syncing ${NAMES[status.stream]}`, detail: `${n(status.cursor)} / ${n(status.head)}${unsynced}`, progress: status.head > 0 ? status.cursor / status.head : 0 };
    case "idle":
      return status.unsynced > 0 ? { text: `${n(status.unsynced)} unsynced` } : undefined;
  }
}
