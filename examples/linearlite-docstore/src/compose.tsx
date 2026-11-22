import { createSignal, onSettled } from "solid-js";
import { CodeLabel, codeItems, MenuButton } from "./menu.tsx";
import type { Code } from "./model.ts";
import type { Draft } from "./store.ts";

/**
 * The dialog for a new issue. `create` gets the draft when it has a title. With "Create more" on, the dialog stays
 * open for the next issue, empty but with the same status and priority, as in Linear. `more` and `setMore` hold that
 * switch, which outlives the dialog.
 */
export function Compose(props: { create(draft: Draft): void; close(): void; more: boolean; setMore(more: boolean): void }) {
  let titleField!: HTMLInputElement;
  let description!: HTMLTextAreaElement;
  const [picked, setPicked] = createSignal<{ status: Code; priority: Code }>({ status: 1, priority: 4 });

  onSettled(() => {
    // Not the `autofocus` attribute, which a browser applies once per page: the dialog opens many times.
    titleField.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.close();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  const pill = (field: "status" | "priority") => (
    <MenuButton
      class="pill"
      title={field === "status" ? "Status" : "Priority"}
      items={codeItems(field, (c) => picked()[field] === c, (c) => setPicked({ ...picked(), [field]: c }))}
    >
      <CodeLabel field={field} code={picked()[field]} />
    </MenuButton>
  );

  return (
    <div
      class="backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) props.close();
      }}
    >
      <form
        class="modal"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const title = String(data.get("title")).trim();
          if (title === "") return titleField.focus();
          props.create({ title, description: String(data.get("description")).trim(), ...picked() });
          if (!props.more) return props.close();
          titleField.value = "";
          description.value = "";
          titleField.focus();
        }}
      >
        <h2>New issue</h2>
        <input ref={(el) => (titleField = el)} type="text" name="title" placeholder="Issue title" autocomplete="off" />
        <textarea ref={(el) => (description = el)} name="description" placeholder="Add a description" />
        <div class="modal-foot">
          {pill("status")}
          {pill("priority")}
          <span class="spacer" />
          <label class="more">
            <input type="checkbox" name="more" role="switch" checked={props.more} onChange={(e) => props.setMore(e.currentTarget.checked)} />
            <span>Create more</span>
          </label>
          <button type="button" class="btn" id="cancel" onClick={() => props.close()}>
            Cancel
          </button>
          <button class="btn primary">Create issue</button>
        </div>
      </form>
    </div>
  );
}
