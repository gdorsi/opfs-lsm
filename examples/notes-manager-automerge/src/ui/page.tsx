import { Link } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useApp } from "../client/app.ts";
import { useBody, useCreatePage, usePage, useSaveState } from "../client/hooks.ts";
import { mountEditor, type MountedEditor } from "../editor/view.ts";
import { MAX_TITLE } from "../model/list.ts";
import type { PageBody, PageId, SaveState } from "../model/types.ts";

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
      <TitleField id={id} title={page.title} onEnter={() => editor.current?.view.focus()} />
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

type LinkAt = { readonly left: number; readonly bottom: number };

function Editor({ body, editor }: { body: PageBody; editor: RefObject<MountedEditor | null> }) {
  const place = useRef<HTMLDivElement>(null);
  const save = useSaveState(body);
  const [refused, setRefused] = useState<string | null>(null);
  const [linkAt, setLinkAt] = useState<LinkAt | null>(null);

  useEffect(() => {
    const mounted = mountEditor(place.current!, body, {
      onRefused: (error) => {
        console.warn("notes: a change was refused", error);
        setRefused(error instanceof Error ? error.message : String(error));
      },
      askHref: setLinkAt,
    });
    editor.current = mounted;
    if (import.meta.env.DEV && globalThis.__notes) globalThis.__notes.editor = mounted;
    return () => {
      mounted.destroy();
      if (editor.current === mounted) editor.current = null;
      if (import.meta.env.DEV && globalThis.__notes?.editor === mounted) globalThis.__notes.editor = undefined;
    };
  }, [body, editor]);

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
    </>
  );
}

function LinkField({ at, onDone }: { at: LinkAt; onDone(href: string | null): void }) {
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
