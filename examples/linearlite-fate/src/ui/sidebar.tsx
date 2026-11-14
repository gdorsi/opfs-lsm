import { Link } from "@tanstack/react-router";
import { keepSearch } from "./nav.ts";
import { useSession } from "../client/fate.ts";
import { useSyncStatus, type SyncStatus } from "../client/hooks.ts";

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

const STORAGE = { kv: "kv on OPFS", idb: "fate IndexedDB" } as const;
const n = (x: number) => x.toLocaleString("en-US");

function SyncFooter() {
  const status = useSyncStatus();
  const { storage } = useSession();
  const text = describe(status);
  return (
    <div className={`sync ${status.kind === "offline" || status.kind === "retrying" ? "sync-offline" : status.kind === "syncing" ? "sync-live" : ""}`} id="sync" role="status">
      {text && <b>{text}</b>}
      {status.error && <span className="mono" title={status.error}>{status.error}</span>}
      <span className="mono" id="storage" data-storage={storage}>
        Cache: {STORAGE[storage]}
      </span>
    </div>
  );
}

function describe(status: SyncStatus): string | undefined {
  const unsynced = status.unsynced > 0 ? `${n(status.unsynced)} unsynced` : "";
  const failed = status.failed > 0 ? `${n(status.failed)} failed` : "";
  const counts = [unsynced, failed].filter((x) => x !== "");
  switch (status.kind) {
    case "offline":
      return ["Offline", ...counts].join(" · ");
    case "retrying":
      return ["Server unreachable", ...counts].join(" · ");
    case "syncing":
      return ["Syncing", ...counts].join(" · ");
    case "idle":
      return counts.length > 0 ? counts.join(" · ") : undefined;
  }
}
