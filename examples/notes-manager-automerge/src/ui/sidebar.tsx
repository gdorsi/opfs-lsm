import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useApp } from "../client/app.ts";
import { useChildren, useCreatePage, useExpanded, usePage } from "../client/hooks.ts";
import type { PageId } from "../model/types.ts";
import { useDismiss } from "./dismiss.ts";

const indent = (depth: number) => ({ "--depth": depth }) as React.CSSProperties;

export function Sidebar() {
  const create = useCreatePage();
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">Notes</span>
        <button className="icon-btn" id="new-page" title="New page" aria-label="New page" onClick={() => void create(null)}>
          <Plus />
        </button>
      </div>
      <nav className="tree" aria-label="Pages">
        <Level parent={null} depth={0} />
      </nav>
      <Footer />
    </aside>
  );
}

function Level({ parent, depth }: { parent: PageId | null; depth: number }) {
  const ids = useChildren(parent);
  if (ids.length === 0) {
    return (
      <div className="tree-empty" style={indent(depth)}>
        {depth === 0 ? "No pages yet" : "No pages inside"}
      </div>
    );
  }
  return ids.map((id) => <Row key={id} id={id} depth={depth} />);
}

function Row({ id, depth }: { id: PageId; depth: number }) {
  const { notes } = useApp();
  const page = usePage(id);
  const { isOpen, set } = useExpanded();
  const open = isOpen(id);
  const navigate = useNavigate();
  const current = useParams({ strict: false }).pageId;
  const [menu, setMenu] = useState<"closed" | "actions" | "confirm">("closed");
  if (!page) return null;
  const title = page.title || "Untitled";

  const onDelete = async () => {
    setMenu("closed");
    if (current && notes.tree.read().subtree(id).includes(current as PageId)) await navigate({ to: "/" });
    notes.deletePage(id);
  };

  return (
    <>
      <div className={`row${current === id ? " active" : ""}`} style={indent(depth)} data-page={id}>
        <button className={`chevron${open ? " open" : ""}`} aria-label={open ? `Collapse ${title}` : `Expand ${title}`} aria-expanded={open} onClick={() => set(id, !open)}>
          <Chevron />
        </button>
        <Link to="/p/$pageId" params={{ pageId: id }} className={`row-title${page.title ? "" : " untitled"}`}>
          {title}
        </Link>
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
      {open && <Level parent={id} depth={depth + 1} />}
    </>
  );
}

function Menu({ onClose, children }: { onClose(): void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  return (
    <div ref={ref} role="menu" className="menu">
      {children}
    </div>
  );
}

function Footer() {
  return (
    <footer className="sidebar-foot">
      <span className="note">Notes are stored on this device only.</span>
    </footer>
  );
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
