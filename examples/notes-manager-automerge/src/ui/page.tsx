import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { useApp } from "../client/app.ts";
import { useBody, useCreatePage, useExpanded, usePage, useSaveState } from "../client/hooks.ts";
import type { Anchor, MenuItem, MenuShown } from "../editor/menu.ts";
import { PAGE_ICON, mountEditor, type MountedEditor, type PageLinks } from "../editor/view.ts";
import { MAX_TITLE } from "../model/list.ts";
import type { PageBody, PageId, SaveState } from "../model/types.ts";
import { useDismiss } from "./dismiss.ts";

export function EmptyState() {
  const create = useCreatePage();
  return (
    <div className="empty" id="empty">
      <p>Select a page or create one.</p>
      <button className="btn" onClick={() => void create(null)}>
        New page
      </button>
    </div>
  );
}

export function NotFound() {
  return (
    <div className="empty" id="not-found">
      <h2>Page not found</h2>
      <p>This page was deleted, or it was never on this device.</p>
      <Link to="/" className="btn">
        Back to pages
      </Link>
    </div>
  );
}

export function PageScreen({ id }: { id: PageId }) {
  const page = usePage(id);
  const editor = useRef<MountedEditor | null>(null);
  if (!page) return <NotFound />;
  return (
    <article className="page" data-page={id}>
      <TitleField id={id} title={page.title} onEnter={() => editor.current?.focusTop()} />
      <Body id={id} editor={editor} />
    </article>
  );
}

function TitleField({ id, title, onEnter }: { id: PageId; title: string; onEnter(): void }) {
  const { notes } = useApp();
  const [draft, setDraft] = useState(title);
  const editing = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const named = useRef(title !== "");

  // A layout effect, because `autoFocus` is lost when the screen mounts behind a suspended boundary and shows later.
  useLayoutEffect(() => {
    if (named.current) return;
    named.current = true;
    input.current?.focus();
  }, []);

  useEffect(() => {
    if (!editing.current) setDraft(title);
  }, [title]);

  const commit = (value: string) => {
    notes.renamePage(id, value.trim());
    setDraft(value.trim());
  };

  return (
    <input
      ref={input}
      className="title"
      id="title"
      aria-label="Page title"
      placeholder="Untitled"
      maxLength={MAX_TITLE}
      value={draft}
      onFocus={() => (editing.current = true)}
      onBlur={(event) => {
        editing.current = false;
        commit(event.currentTarget.value);
      }}
      onChange={(event) => {
        setDraft(event.currentTarget.value);
        notes.renamePage(id, event.currentTarget.value);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        commit(event.currentTarget.value);
        onEnter();
      }}
    />
  );
}

function Body({ id, editor }: { id: PageId; editor: RefObject<MountedEditor | null> }) {
  const { body, error } = useBody(id);
  if (error) {
    return (
      <div className="banner error" role="alert">
        Cannot open this page's text: {error.message}
      </div>
    );
  }
  if (!body) return <div className="editor" aria-busy />;
  return <Editor body={body} editor={editor} />;
}

type At = { readonly left: number; readonly bottom: number };
type DeleteAsk = { readonly ids: readonly PageId[]; readonly at: Anchor; confirm(): void };

/** What the editor's page blocks and `/` menu call, read fresh on each call so the editor mounts once per body. */
function usePageLinks(parent: PageId): PageLinks {
  const { notes } = useApp();
  const navigate = useNavigate();
  const router = useRouter();
  const { set: expand } = useExpanded();
  const latest = useRef({ notes, navigate, router, expand });
  latest.current = { notes, navigate, router, expand };
  const [links] = useState<PageLinks>(() => ({
    tree: notes.tree,
    create() {
      latest.current.expand(parent, true);
      return latest.current.notes.createPage(parent);
    },
    open(id) {
      void latest.current.navigate({ to: "/p/$pageId", params: { pageId: id } });
    },
    href: (id) => latest.current.router.buildLocation({ to: "/p/$pageId", params: { pageId: id } }).href,
  }));
  return links;
}

function Editor({ body, editor }: { body: PageBody; editor: RefObject<MountedEditor | null> }) {
  const { notes } = useApp();
  const place = useRef<HTMLDivElement>(null);
  const save = useSaveState(body);
  const links = usePageLinks(body.id);
  const [refused, setRefused] = useState<string | null>(null);
  const [linkAt, setLinkAt] = useState<At | null>(null);
  const [menu, setMenu] = useState<MenuShown | null>(null);
  const [ask, setAsk] = useState<DeleteAsk | null>(null);

  useEffect(() => {
    const mounted = mountEditor(place.current!, body, {
      onRefused: (error) => {
        console.warn("notes: a change was refused", error);
        setRefused(error instanceof Error ? error.message : String(error));
      },
      askHref: setLinkAt,
      pages: links,
      onMenu: setMenu,
      askDelete: setAsk,
    });
    editor.current = mounted;
    if (import.meta.env.DEV && globalThis.__notes) globalThis.__notes.editor = mounted;
    return () => {
      mounted.destroy();
      if (editor.current === mounted) editor.current = null;
      if (import.meta.env.DEV && globalThis.__notes?.editor === mounted) globalThis.__notes.editor = undefined;
    };
  }, [body, editor, links]);

  const closeAsk = useCallback(() => {
    setAsk(null);
    editor.current?.view.focus();
  }, [editor]);

  return (
    <>
      <SaveLabel save={save} />
      {refused && (
        <div className="banner error" role="alert">
          A change was not applied: {refused}
          <button className="link-btn" onClick={() => setRefused(null)}>
            Dismiss
          </button>
        </div>
      )}
      <div ref={place} className="editor" id="editor" data-save={save.state} />
      {linkAt && (
        <LinkField
          at={linkAt}
          onDone={(href) => {
            setLinkAt(null);
            editor.current?.link(href);
          }}
        />
      )}
      {menu && <MenuList menu={menu} onPick={(i) => editor.current?.pickMenu(i)} onPoint={(i) => editor.current?.pointMenu(i)} />}
      {ask && (
        <DeleteConfirm
          ask={ask}
          onCancel={closeAsk}
          onDelete={() => {
            ask.confirm();
            for (const id of ask.ids) notes.deletePage(id);
            closeAsk();
          }}
        />
      )}
    </>
  );
}

const MARGIN = 8;
const GAP = 6;

/**
 * Below `at`, or above it when `height` does not fit below and more room is above. Inside the window even when `at`
 * is scrolled out of it, and no taller than the room on its side.
 */
function placeAt(at: Anchor, width: number, height: number): CSSProperties {
  const left = Math.max(MARGIN, Math.min(at.left, innerWidth - width - MARGIN));
  const top = Math.max(MARGIN, at.bottom + GAP);
  const bottom = Math.max(MARGIN, innerHeight - at.top + GAP);
  const below = innerHeight - MARGIN - top;
  const above = innerHeight - MARGIN - bottom;
  return below >= height || below >= above ? { left, width, top, maxHeight: Math.min(height, below) } : { left, width, bottom, maxHeight: Math.min(height, above) };
}

/** The `/` menu lists two-line rows; the block menu is a compact filter list in two groups: turn into, then the rest. */
function MenuList({ menu, onPick, onPoint }: { menu: MenuShown; onPick(index: number): void; onPoint(index: number): void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${menu.index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [menu.index]);
  const block = menu.kind === "block";
  return (
    <div
      ref={list}
      className={`editor-menu${block ? " compact" : ""}`}
      id="editor-menu"
      role="listbox"
      aria-label={block ? "Block actions" : "Add a block"}
      style={placeAt(menu.at, block ? 240 : 300, 340)}
      // Keeps the editor focused, so typing keeps filtering and the keys keep working.
      onMouseDown={(event) => event.preventDefault()}
    >
      {block && (
        <div className="menu-query" aria-hidden>
          {menu.query || <span>Type to filter</span>}
        </div>
      )}
      {menu.items.map((item, i) => {
        const turns = item.action.type === "turn";
        const first = block && (i === 0 || (menu.items[i - 1]!.action.type === "turn") !== turns);
        return (
          <Fragment key={item.label}>
            {first &&
              (turns ? (
                <div className="menu-heading" aria-hidden>
                  Turn into
                </div>
              ) : (
                i > 0 && <div className="menu-divider" aria-hidden />
              ))}
            <div
              role="option"
              id={`editor-menu-${i}`}
              aria-selected={i === menu.index}
              data-index={i}
              className={`menu-item${i === menu.index ? " on" : ""}${item.action.type === "delete" ? " danger" : ""}`}
              onMouseMove={() => i !== menu.index && onPoint(i)}
              onClick={() => onPick(i)}
            >
              <span className="menu-icon" aria-hidden>
                <MenuIcon item={item} />
              </span>
              <span className="menu-copy">
                <span className="menu-label">{item.label}</span>
                {!block && <span className="menu-hint">{item.hint}</span>}
              </span>
              {i === menu.current && (
                <svg className="tick" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="Current">
                  <path d="M3.5 8.5l3 3 6-7" />
                </svg>
              )}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

const ICONS = {
  page: PAGE_ICON,
  open: ["M7 4H4.75A.75.75 0 0 0 4 4.75v8.5c0 .41.34.75.75.75h8.5c.41 0 .75-.34.75-.75V11", "M10 4h4v4M14 4l-6 6"],
  duplicate: ["M6.5 6.5h6.75c.41 0 .75.34.75.75v6c0 .41-.34.75-.75.75H7.25a.75.75 0 0 1-.75-.75z", "M4 11.5V4.75C4 4.34 4.34 4 4.75 4H11"],
  delete: ["M3.5 5h11M7 5V3.5h4V5M5 5l.6 8.4c.03.38.35.6.75.6h5.3c.4 0 .72-.22.75-.6L13 5", "M7.5 8v3.5M10.5 8v3.5"],
} as const;

function MenuIcon({ item }: { item: MenuItem }) {
  const { action } = item;
  if (action.type === "turn") {
    const block = action.block({ type: "paragraph" });
    switch (block.type) {
      case "heading":
        return <span className="menu-glyph">H{block.level}</span>;
      case "item":
        return <span className={`menu-glyph${block.list === "bullet" ? " bullet" : ""}`}>{block.list === "bullet" ? "•" : "1."}</span>;
      case "todo":
        return <span className="menu-box" />;
      default:
        return <span className="menu-glyph">Aa</span>;
    }
  }
  return (
    <svg width="20" height="20" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      {ICONS[action.type].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

function DeleteConfirm({ ask, onCancel, onDelete }: { ask: DeleteAsk; onCancel(): void; onDelete(): void }) {
  const { notes } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onCancel);
  const [first] = ask.ids;
  const title = (first && notes.tree.read().page(first)?.title) || "Untitled";
  return (
    <div ref={ref} role="alertdialog" aria-label="Delete page" className="menu popover" style={placeAt(ask.at, 244, 160)}>
      <p className="menu-text">
        {ask.ids.length === 1 ? (
          <>
            Delete <b>{title}</b> and the pages inside it?
          </>
        ) : (
          <>
            Delete <b>{ask.ids.length} pages</b> and the pages inside them?
          </>
        )}
      </p>
      <div className="menu-row">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn danger" id="confirm-delete-page" autoFocus onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}

function LinkField({ at, onDone }: { at: At; onDone(href: string | null): void }) {
  const [href, setHref] = useState("");
  return (
    <form
      className="link-field"
      style={{ left: at.left, top: at.bottom + 6 }}
      onSubmit={(event) => {
        event.preventDefault();
        onDone(href);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onDone(null);
      }}
    >
      <input
        autoFocus
        id="link-url"
        inputMode="url"
        aria-label="Link URL"
        placeholder="Paste a link"
        value={href}
        onChange={(event) => setHref(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          onDone(null);
        }}
      />
      <button type="submit" className="btn">
        Link
      </button>
    </form>
  );
}

function SaveLabel({ save }: { save: SaveState }) {
  const text = save.state === "saving" ? "Saving…" : save.state === "saved" ? "Saved on this device" : save.state === "error" ? `Not saved: ${save.error.message}` : null;
  if (!text) return null;
  return (
    <div className={`save save-${save.state}`} id="save" role="status">
      {text}
    </div>
  );
}
