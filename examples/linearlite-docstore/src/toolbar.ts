import { codeItems, openMenu, type Item } from "./menu.ts";
import { DEFAULT_FILTER, PRIORITY_LABELS, SORTS, SORT_LABELS, STATUS_LABELS, type Code, type Filter } from "./model.ts";

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

/** The filter chips, the sort menu, the title search and the button for a new issue. `change` gets every new filter. */
export function createToolbar(bar: HTMLElement, change: (filter: Filter) => void, create: () => void) {
  bar.innerHTML =
    `<span class="title">All issues</span><span id="count" class="count mono"></span><div class="chips">` +
    `<button class="chip" title="Filter by status"></button><button class="chip" title="Filter by priority"></button>` +
    `<button class="chip plain" data-clear>Clear</button><button class="chip plain" title="Sort"></button></div>` +
    `<button class="btn primary" id="new">New issue</button>` +
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

  const codes = (field: "status" | "priority") => () => codeItems(field, (c) => filter[field].includes(c), (c) => set({ [field]: toggled(filter[field], c) }));
  status!.onclick = () => openMenu(status!, codes("status"), true);
  priority!.onclick = () => openMenu(priority!, codes("priority"), true);
  bar.querySelector<HTMLButtonElement>("#new")!.onclick = create;
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
