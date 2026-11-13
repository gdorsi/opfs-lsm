import { useEffect, useRef, useState } from "react";
import { CodeLabel, codeItems, MenuButton } from "./menu.tsx";
import type { Code } from "./model.ts";
import type { Draft } from "./store.ts";

/** "Create more" keeps its state until the page reloads. */
let createMore = false;

/**
 * The dialog for a new issue. `create` gets the draft when it has a title. With "Create more" on, the dialog stays
 * open for the next issue, empty but with the same status and priority, as in Linear.
 */
export function Compose({ create, close }: { create(draft: Draft): void; close(): void }) {
  const titleField = useRef<HTMLInputElement>(null);
  const description = useRef<HTMLTextAreaElement>(null);
  const [picked, setPicked] = useState<{ status: Code; priority: Code }>({ status: 1, priority: 4 });
  const [more, setMore] = useState(createMore);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [close]);

  const pill = (field: "status" | "priority") => (
    <MenuButton
      className="pill"
      title={field === "status" ? "Status" : "Priority"}
      items={codeItems(field, (c) => picked[field] === c, (c) => setPicked({ ...picked, [field]: c }))}
    >
      <CodeLabel field={field} code={picked[field]} />
    </MenuButton>
  );

  return (
    <div
      className="backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <form
        className="modal"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const title = String(data.get("title")).trim();
          if (title === "") return titleField.current!.focus();
          create({ title, description: String(data.get("description")).trim(), ...picked });
          if (!more) return close();
          titleField.current!.value = "";
          description.current!.value = "";
          titleField.current!.focus();
        }}
      >
        <h2>New issue</h2>
        <input ref={titleField} type="text" name="title" placeholder="Issue title" autoComplete="off" autoFocus />
        <textarea ref={description} name="description" placeholder="Add a description" />
        <div className="modal-foot">
          {pill("status")}
          {pill("priority")}
          <span className="spacer" />
          <label className="more">
            <input
              type="checkbox"
              name="more"
              role="switch"
              checked={more}
              onChange={(e) => {
                createMore = e.target.checked;
                setMore(createMore);
              }}
            />
            <span>Create more</span>
          </label>
          <button type="button" className="btn" id="cancel" onClick={close}>
            Cancel
          </button>
          <button className="btn primary">Create issue</button>
        </div>
      </form>
    </div>
  );
}
