import { CHECK, priorityIcon, statusIcon } from "./icons.ts";
import { CODES, PRIORITY_LABELS, STATUS_LABELS, type Code } from "./model.ts";

export type Item = { readonly html: string; readonly on: boolean; pick(): void } | { readonly head: string } | "separator";

let closeMenu = () => {};

/** A menu under `anchor`. `items` is called again after every pick, so a menu of toggles stays open and current. */
export function openMenu(anchor: HTMLElement, items: () => Item[], keepOpen: boolean) {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");
  const draw = () => {
    menu.replaceChildren(
      ...items().map((item) => {
        if (item === "separator" || "head" in item) {
          const el = document.createElement("div");
          el.className = item === "separator" ? "menu-sep" : "menu-head";
          if (item !== "separator") el.textContent = item.head;
          return el;
        }
        const el = document.createElement("button");
        el.className = "menu-item";
        el.setAttribute("role", "menuitem");
        el.innerHTML = `${item.html}<span class="tick">${item.on ? CHECK : ""}</span>`;
        el.onclick = () => {
          item.pick();
          if (keepOpen) draw();
          else closeMenu();
        };
        return el;
      }),
    );
  };
  draw();
  document.body.append(menu);
  const box = anchor.getBoundingClientRect();
  menu.style.top = `${box.bottom + 4}px`;
  menu.style.left = `${Math.max(8, Math.min(box.left, innerWidth - menu.offsetWidth - 8))}px`;
  const outside = (e: Event) => {
    if (e instanceof KeyboardEvent) {
      if (e.key !== "Escape") return;
      // The menu takes the key, so the page or dialog under it stays open.
      e.stopPropagation();
      closeMenu();
    } else if (!menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) closeMenu();
  };
  addEventListener("pointerdown", outside, true);
  addEventListener("keydown", outside, true);
  closeMenu = () => {
    menu.remove();
    removeEventListener("pointerdown", outside, true);
    removeEventListener("keydown", outside, true);
    closeMenu = () => {};
  };
}

/** The items of a menu that picks one status or one priority. */
export const codeItems = (field: "status" | "priority", on: (code: Code) => boolean, pick: (code: Code) => void): Item[] =>
  CODES.map((c) => ({ html: codeLabel(field, c), on: on(c), pick: () => pick(c) }));

/** A status or a priority as its icon and its name. */
export const codeLabel = (field: "status" | "priority", code: Code) =>
  field === "status" ? `${statusIcon(code)}<span>${STATUS_LABELS[code]}</span>` : `${priorityIcon(code)}<span>${PRIORITY_LABELS[code]}</span>`;
