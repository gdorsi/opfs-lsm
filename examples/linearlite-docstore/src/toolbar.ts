import { CHECK, priorityIcon, statusIcon } from "./icons.ts";
import { CODES, DEFAULT_FILTER, PRIORITY_LABELS, SORTS, SORT_LABELS, STATUS_LABELS, type Code, type Filter } from "./model.ts";

type Item = { readonly html: string; readonly on: boolean; pick(): void } | { readonly head: string } | "separator";

let closeMenu = () => {};

/** A menu under `anchor`. `items` is called again after every pick, so a menu of toggles stays open and current. */
function openMenu(anchor: HTMLElement, items: () => Item[], keepOpen: boolean) {
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
    if (e instanceof KeyboardEvent ? e.key === "Escape" : !menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) closeMenu();
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

const toggled = (codes: readonly Code[], code: Code) => (codes.includes(code) ? codes.filter((c) => c !== code) : [...codes, code].sort((a, b) => a - b));

/** What changed between two filters, for the page that shows the timing of the change. */
export function describe(filter: Filter, before: Filter): string {
  const parts: string[] = [];
  if (String(filter.status) !== String(before.status)) parts.push(filter.status.length ? `Status: ${filter.status.map((c) => STATUS_LABELS[c]).join(", ")}` : "Status cleared");
  if (String(filter.priority) !== String(before.priority)) parts.push(filter.priority.length ? `Priority: ${filter.priority.map((c) => PRIORITY_LABELS[c]).join(", ")}` : "Priority cleared");
  if (filter.q !== before.q) parts.push(filter.q ? `Search "${filter.q}"` : "Search cleared");
  if (filter.sort !== before.sort || filter.dir !== before.dir) parts.push(`Sorted by ${filter.sort}, ${filter.dir === "asc" ? "ascending" : "descending"}`);
  return parts.join(" · ");
}

/** The filter chips, the sort menu and the title search. `change` gets every new filter. */
export function createToolbar(bar: HTMLElement, change: (filter: Filter) => void) {
  bar.innerHTML =
    `<span class="title">All issues</span><span id="count" class="count mono"></span><div class="chips">` +
    `<button class="chip" title="Filter by status"></button><button class="chip" title="Filter by priority"></button>` +
    `<button class="chip plain" data-clear>Clear</button><button class="chip plain" title="Sort"></button></div>` +
    `<label class="search"><input id="search" type="search" placeholder="Search titles" autocomplete="off" /></label>`;
  const [status, priority, clear, sort] = bar.querySelectorAll<HTMLButtonElement>(".chip");
  const search = bar.querySelector<HTMLInputElement>("#search")!;
  const count = bar.querySelector<HTMLElement>("#count")!;
  let filter = DEFAULT_FILTER;

  const draw = () => {
    const chip = (el: HTMLButtonElement, name: string, codes: readonly Code[], labels: readonly string[]) => {
      el.classList.toggle("on", codes.length > 0);
      el.textContent = codes.length === 0 ? name : codes.length === 1 ? labels[codes[0]!]! : `${codes.length} ${name === "Status" ? "statuses" : "priorities"}`;
    };
    chip(status!, "Status", filter.status, STATUS_LABELS);
    chip(priority!, "Priority", filter.priority, PRIORITY_LABELS);
    clear!.hidden = filter.status.length === 0 && filter.priority.length === 0 && filter.q === "";
    sort!.textContent = `${SORT_LABELS[filter.sort]} ${filter.dir === "desc" ? "↓" : "↑"}`;
  };
  const set = (patch: Partial<Filter>) => {
    filter = { ...filter, ...patch };
    draw();
    change(filter);
  };

  const codes = (field: "status" | "priority", labels: readonly string[], icon: (c: Code) => string) => () =>
    CODES.map((c): Item => ({ html: `${icon(c)}<span>${labels[c]}</span>`, on: filter[field].includes(c), pick: () => set({ [field]: toggled(filter[field], c) }) }));
  status!.onclick = () => openMenu(status!, codes("status", STATUS_LABELS, statusIcon), true);
  priority!.onclick = () => openMenu(priority!, codes("priority", PRIORITY_LABELS, priorityIcon), true);
  sort!.onclick = () =>
    openMenu(
      sort!,
      () => [
        { head: "Order by" },
        ...SORTS.map((s): Item => ({ html: `<span>${SORT_LABELS[s]}</span>`, on: filter.sort === s, pick: () => set({ sort: s }) })),
        "separator",
        { html: "<span>Descending</span>", on: filter.dir === "desc", pick: () => set({ dir: "desc" }) },
        { html: "<span>Ascending</span>", on: filter.dir === "asc", pick: () => set({ dir: "asc" }) },
      ],
      false,
    );
  clear!.onclick = () => {
    search.value = "";
    set({ status: [], priority: [], q: "" });
  };

  let typing = 0;
  search.oninput = () => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      const q = search.value.trim();
      if (q !== filter.q) set({ q });
    }, 80);
  };

  draw();
  return {
    /** The total beside the title. Undefined clears it while a count is running. */
    count(total: number | undefined) {
      count.textContent = total === undefined ? "" : total.toLocaleString("en-US");
    },
  };
}
