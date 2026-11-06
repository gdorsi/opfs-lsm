import { EditorContent, useEditor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import { createDebouncedSave, type DebouncedSave } from "./debounced-save";
import type { DocumentStore } from "./kv-document-store";

type SaveState = "idle" | "loading" | "saving" | "saved" | "error";

/** `flush` returns true while a save is running; the database must stay open. */
export type AppShutdown = {
  flush: () => boolean;
};

export function App({
  store,
  shutdown,
}: {
  store: DocumentStore;
  shutdown: AppShutdown;
}) {
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [error, setError] = useState("");
  const lastSaved = useRef<string>("");
  const applyingRemote = useRef(false);
  const alive = useRef(true);
  const storeRef = useRef(store);
  storeRef.current = store;
  const saving = useRef<DebouncedSave<JSONContent> | null>(null);

  let debounced = saving.current;
  if (debounced === null) {
    debounced = createDebouncedSave({
      delayMs: 300,
      save: async (json) => {
        await storeRef.current.save(json);
        lastSaved.current = JSON.stringify(json);
        if (!alive.current || saving.current?.hasPending()) return;
        setError("");
        setSaveState("saved");
      },
      onError: (err) => {
        if (!alive.current) {
          console.error(err);
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
        setSaveState("error");
      },
    });
    saving.current = debounced;
  }
  // Assigned during render so a refresh before effects still flushes.
  shutdown.flush = () => saving.current?.flush() ?? false;

  function onError(err: unknown) {
    if (!alive.current) return;
    setError(err instanceof Error ? err.message : String(err));
    setSaveState("error");
  }

  const editor = useEditor({
    extensions: [StarterKit],
    content: "",
    editorProps: {
      attributes: {
        "aria-label": "Rich text document",
      },
    },
    onUpdate: ({ editor }) => {
      if (applyingRemote.current) return;
      const json = editor.getJSON();
      if (JSON.stringify(json) === lastSaved.current) return;
      setError("");
      setSaveState("saving");
      saving.current?.push(json);
    },
  });

  async function loadIntoEditor() {
    if (!editor) return;
    const doc = await store.load();
    if (!alive.current || !editor) return;
    const json = (doc as JSONContent | null) ?? {
      type: "doc",
      content: [{ type: "paragraph" }],
    };
    applyingRemote.current = true;
    try {
      editor.commands.setContent(json, false);
      lastSaved.current = JSON.stringify(editor.getJSON());
      setError("");
      setSaveState("saved");
    } finally {
      applyingRemote.current = false;
    }
  }

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      saving.current?.flush();
    };
  }, []);

  useEffect(() => {
    if (!editor) return;
    void loadIntoEditor().catch(onError);
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    return store.onChange(() => {
      // Own puts notify too. Skip them, and skip remote updates while a
      // local edit has not been written yet.
      void (async () => {
        if (saving.current?.busy()) return;
        await store.sync();
        if (!alive.current || saving.current?.busy()) return;
        const doc = await store.load();
        if (!alive.current || !doc) return;
        const serialized = JSON.stringify(doc);
        if (serialized === lastSaved.current) return;
        applyingRemote.current = true;
        try {
          editor.commands.setContent(doc as JSONContent, false);
          lastSaved.current = JSON.stringify(editor.getJSON());
          setSaveState("saved");
        } finally {
          applyingRemote.current = false;
        }
      })().catch(onError);
    });
  }, [editor, store]);

  if (!editor) return <p className="meta">Starting editor…</p>;

  return (
    <main>
      <h1>Rich text (persisted with @opfs-lsm/kv)</h1>
      <p className="lede">
        Document <code>{store.docId}</code> in database <code>{store.dbName}</code>.
        Edits are saved as JSON values in kv. Open the same URL in a second window
        to see cross-tab reloads.
      </p>
      <p className="meta" aria-live="polite">
        {saveState === "loading" && "Loading…"}
        {saveState === "saving" && "Saving…"}
        {saveState === "saved" && "Saved to kv"}
        {saveState === "error" && "Save failed"}
        {saveState === "idle" && ""}
      </p>
      <p className="error" role="alert">{error}</p>

      <div className="editor-shell">
        <div className="toolbar" role="toolbar" aria-label="Formatting">
          <button
            type="button"
            className={editor.isActive("bold") ? "is-active" : ""}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            Bold
          </button>
          <button
            type="button"
            className={editor.isActive("italic") ? "is-active" : ""}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            Italic
          </button>
          <button
            type="button"
            className={editor.isActive("heading", { level: 1 }) ? "is-active" : ""}
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          >
            H1
          </button>
          <button
            type="button"
            className={editor.isActive("heading", { level: 2 }) ? "is-active" : ""}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          >
            H2
          </button>
          <button
            type="button"
            className={editor.isActive("bulletList") ? "is-active" : ""}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            Bullet list
          </button>
          <button
            type="button"
            className={editor.isActive("orderedList") ? "is-active" : ""}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          >
            Numbered list
          </button>
          <button
            type="button"
            className={editor.isActive("blockquote") ? "is-active" : ""}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
          >
            Quote
          </button>
          <button
            type="button"
            className={editor.isActive("codeBlock") ? "is-active" : ""}
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          >
            Code block
          </button>
          <button
            type="button"
            onClick={() => window.open(location.href, "_blank")}
          >
            Open second window
          </button>
        </div>
        <EditorContent editor={editor} />
      </div>
    </main>
  );
}
