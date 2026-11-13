import { codeItems, codeLabel, openMenu } from "./menu.ts";
import type { Code } from "./model.ts";
import type { Draft } from "./store.ts";

/**
 * The dialog for a new issue. `create` gets the draft when it has a title. With "Create more" on, the dialog stays
 * open for the next issue, empty but with the same status and priority, as in Linear. The switch keeps its state
 * until the page reloads.
 */
let createMore = false;

export function openCompose(create: (draft: Draft) => void) {
  const backdrop = document.createElement("div");
  backdrop.className = "backdrop";
  backdrop.innerHTML = `
<form class="modal">
  <h2>New issue</h2>
  <input type="text" name="title" placeholder="Issue title" autocomplete="off" />
  <textarea name="description" placeholder="Add a description"></textarea>
  <div class="modal-foot">
    <button type="button" class="pill" title="Status"></button><button type="button" class="pill" title="Priority"></button>
    <span class="spacer"></span>
    <label class="more"><input type="checkbox" name="more" role="switch" /><span>Create more</span></label>
    <button type="button" class="btn" id="cancel">Cancel</button><button class="btn primary">Create issue</button>
  </div>
</form>`;
  const form = backdrop.querySelector("form")!;
  const picked: { status: Code; priority: Code } = { status: 1, priority: 4 };
  const more = form.querySelector<HTMLInputElement>("[name=more]")!;
  more.checked = createMore;
  more.onchange = () => (createMore = more.checked);
  for (const field of ["status", "priority"] as const) {
    const pill = form.querySelector<HTMLButtonElement>(`[title="${field === "status" ? "Status" : "Priority"}"]`)!;
    const draw = () => (pill.innerHTML = codeLabel(field, picked[field]));
    pill.onclick = () =>
      openMenu(
        pill,
        () =>
          codeItems(field, (c) => picked[field] === c, (c) => {
            picked[field] = c;
            draw();
          }),
        false,
      );
    draw();
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  const close = () => {
    backdrop.remove();
    removeEventListener("keydown", onKey);
  };
  addEventListener("keydown", onKey);
  backdrop.onpointerdown = (e) => {
    if (e.target === backdrop) close();
  };
  form.querySelector<HTMLButtonElement>("#cancel")!.onclick = close;
  form.onsubmit = (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const title = String(data.get("title")).trim();
    const titleField = form.querySelector<HTMLInputElement>("[name=title]")!;
    if (title === "") return titleField.focus();
    create({ title, description: String(data.get("description")).trim(), ...picked });
    if (!more.checked) return close();
    titleField.value = "";
    form.querySelector<HTMLTextAreaElement>("[name=description]")!.value = "";
    titleField.focus();
  };
  document.body.append(backdrop);
  form.querySelector<HTMLInputElement>("[name=title]")!.focus();
}
