import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useListView, useRequest, useView, type ViewRef } from "react-fate";
import { useApp } from "../client/app.ts";
import { useCreatePage, useExpanded, usePending, useRefetchOnDelivery, useSyncStatus, type SyncStatus } from "../client/hooks.ts";
import { cachedSubtree, ChildListView, childrenRequest, deletePage, PageRowView, TREE_REQUEST } from "../model/tree.ts";
import type { PageId } from "../model/types.ts";
import { Loading } from "./boundary.tsx";

const indent = (depth: number) => ({ "--depth": depth }) as React.CSSProperties;

export function Sidebar() {
  const create = useCreatePage();
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">Pages</span>
        <button className="icon-btn" id="new-page" title="New page" aria-label="New page" onClick={() => void create(null)}>
          <Plus />
        </button>
      </div>
      <nav className="tree" aria-label="Pages">
        <Loading fallback={<Skeleton depth={0} />}>
          <Level parent={null} depth={0} />
        </Loading>
      </nav>
      <SyncFooter />
    </aside>
  );
}

function Level({ parent, depth }: { parent: PageId | null; depth: number }) {
  const request = useMemo(() => childrenRequest(parent), [parent]);
  const { children } = useRequest(request, TREE_REQUEST);
  useRefetchOnDelivery(request);
  const [items = [], loadNext] = useListView(ChildListView, children);
  if (items.length === 0) {
    return (
      <div className="tree-empty" style={indent(depth)}>
        {depth === 0 ? "No pages yet" : "No pages inside"}
      </div>
    );
  }
  return (
    <>
      {items.map(({ node }) => (
        <Row key={node.id} page={node} depth={depth} />
      ))}
      {loadNext && (
        <button className="tree-more" style={indent(depth)} onClick={() => void loadNext()}>
          Show more
        </button>
      )}
    </>
  );
}

function Row({ page, depth }: { page: ViewRef<"Page">; depth: number }) {
  const { fate } = useApp();
  const row = useView(PageRowView, page);
  const id = row.id as PageId;
  const title = row.title || "Untitled";
  const { isOpen, set } = useExpanded();
  const open = isOpen(id);
  const pending = usePending(id);
  const create = useCreatePage();
  const navigate = useNavigate();
  const current = useParams({ strict: false }).pageId;
  const [menu, setMenu] = useState<"closed" | "actions" | "confirm">("closed");

  const onNewChild = () => {
    set(id, true);
    void create(id);
  };
  const onDelete = async () => {
    setMenu("closed");
    if (current && (current === id || (await cachedSubtree(fate, id)).includes(current as PageId))) await navigate({ to: "/" });
    await deletePage(fate, id);
  };

  return (
    <>
      <div className={`row${current === id ? " active" : ""}`} style={indent(depth)} data-page={id}>
        <button className={`chevron${open ? " open" : ""}`} aria-label={open ? `Collapse ${title}` : `Expand ${title}`} aria-expanded={open} onClick={() => set(id, !open)}>
          <Chevron />
        </button>
        <Link to="/p/$pageId" params={{ pageId: id }} className={`row-title${row.title ? "" : " untitled"}`}>
          {title}
        </Link>
        {pending && <span className="unsynced" title="Not synced yet" aria-label="Not synced yet" />}
        <span className="row-actions">
          <button
            className="icon-btn"
            title="More"
            aria-label={`More for ${title}`}
            aria-haspopup="menu"
            aria-expanded={menu !== "closed"}
            onClick={() => setMenu(menu === "closed" ? "actions" : "closed")}
          >
            <Dots />
          </button>
          <button className="icon-btn" title="Add a page inside" aria-label={`Add a page inside ${title}`} onClick={onNewChild}>
            <Plus />
          </button>
        </span>
        {menu === "actions" && (
          <Menu onClose={() => setMenu("closed")}>
            <button role="menuitem" className="danger" onClick={() => setMenu("confirm")}>
              Delete
            </button>
          </Menu>
        )}
        {menu === "confirm" && (
          <Menu onClose={() => setMenu("closed")}>
            <p className="menu-text">
              Delete <b>{title}</b> and the pages inside it?
            </p>
            <div className="menu-row">
              <button role="menuitem" className="btn" onClick={() => setMenu("closed")}>
                Cancel
              </button>
              <button role="menuitem" className="btn danger" id="confirm-delete" autoFocus onClick={() => void onDelete()}>
                Delete
              </button>
            </div>
          </Menu>
        )}
      </div>
      {open && (
        <Loading fallback={<Skeleton depth={depth + 1} />}>
          <Level parent={id} depth={depth + 1} />
        </Loading>
      )}
    </>
  );
}

function Menu({ onClose, children }: { onClose(): void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (event: Event) => ref.current && !ref.current.contains(event.target as Node) && onClose();
    const escape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [onClose]);
  return (
    <div ref={ref} role="menu" className="menu">
      {children}
    </div>
  );
}

function Skeleton({ depth }: { depth: number }) {
  return (
    <div className="tree-empty" style={indent(depth)} aria-busy>
      Loading…
    </div>
  );
}

const STORAGE = { kv: "kv on OPFS", idb: "IndexedDB" } as const;
const ACTION: Record<string, string> = { createPage: "A new page", renamePage: "A rename", deletePage: "A delete" };

function SyncFooter() {
  const { fate, kind } = useApp();
  const status = useSyncStatus();
  const text = describe(status);
  return (
    <footer className={`sync sync-${status.kind}`} id="sync" role="status">
      {text && <b>{text}</b>}
      {status.failed.map((entry) => (
        <div className="refused" key={entry.id}>
          <span>
            {ACTION[entry.name] ?? entry.name} was refused{entry.error ? `: ${entry.error}` : ""}
          </span>
          <button className="link-btn" onClick={() => void fate.persistence!.discard(entry.id)}>
            Discard
          </button>
        </div>
      ))}
      <span className="mono" id="storage" data-storage={kind}>
        Storage: {STORAGE[kind]}
      </span>
      <span className="note">Page text is stored on this device only.</span>
    </footer>
  );
}

function describe(status: SyncStatus): string | undefined {
  const unsynced = status.unsynced > 0 ? `${status.unsynced} unsynced` : "";
  switch (status.kind) {
    case "offline":
      return ["Offline", unsynced].filter(Boolean).join(" · ");
    case "retrying":
      return ["Server unreachable", unsynced].filter(Boolean).join(" · ");
    case "syncing":
      return ["Syncing", unsynced].filter(Boolean).join(" · ");
    case "idle":
      return undefined;
  }
}

function Plus() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M7 2.5v9M2.5 7h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function Dots() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <circle cx="3" cy="7" r="1.2" fill="currentColor" />
      <circle cx="7" cy="7" r="1.2" fill="currentColor" />
      <circle cx="11" cy="7" r="1.2" fill="currentColor" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M4.5 3l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
