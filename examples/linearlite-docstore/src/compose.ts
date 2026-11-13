import { codeItems, codeLabel, openMenu } from "./menu.ts";
import type { Code } from "./model.ts";
import type { Draft } from "./store.ts";

/** The dialog for a new issue. `create` gets the draft when it has a title. */
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
    <button type="button" class="btn" id="cancel">Cancel</button><button class="btn primary">Create issue</button>
  </div>
</form>`;
  const form = backdrop.querySelector("form")!;
  const picked: { status: Code; priority: Code } = { status: 1, priority: 4 };
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
    if (title === "") return form.querySelector<HTMLInputElement>("[name=title]")!.focus();
    close();
    create({ title, description: String(data.get("description")).trim(), ...picked });
  };
  document.body.append(backdrop);
  form.querySelector<HTMLInputElement>("[name=title]")!.focus();
}
