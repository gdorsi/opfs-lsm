import { EditorContent, useEditor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import type { DocumentStore } from "./kv-document-store";

type SaveState = "idle" | "loading" | "saving" | "saved" | "error";

export function App({ store }: { store: DocumentStore }) {
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [error, setError] = useState("");
  const saveTimer = useRef<number | undefined>(undefined);
  const lastSaved = useRef<string>("");
  const applyingRemote = useRef(false);

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
      const serialized = JSON.stringify(json);
      if (serialized === lastSaved.current) return;
      window.clearTimeout(saveTimer.current);
      setSaveState("saving");
      saveTimer.current = window.setTimeout(() => {
        void persist(json).catch(onError);
      }, 300);
    },
  });

  function onError(err: unknown) {
    setError(err instanceof Error ? err.message : String(err));
    setSaveState("error");
  }

  async function persist(json: JSONContent) {
    await store.save(json);
    lastSaved.current = JSON.stringify(json);
    setError("");
    setSaveState("saved");
  }

  async function loadIntoEditor() {
    if (!editor) return;
    const doc = await store.load();
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
    if (!editor) return;
    void loadIntoEditor().catch(onError);
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    return store.onChange(() => {
      // Another tab wrote; sync WAL tail then reload if content differs.
      void (async () => {
        await store.sync();
        const doc = await store.load();
        if (!doc) return;
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
