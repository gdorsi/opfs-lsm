import { useEffect, useState } from "react";
import { codeItems, MenuButton, type Item } from "./menu.tsx";
import { PRIORITY_LABELS, SORTS, SORT_LABELS, STATUS_LABELS, type Code, type Filter } from "./model.ts";

const toggled = (codes: readonly Code[], code: Code) => (codes.includes(code) ? codes.filter((c) => c !== code) : [...codes, code].sort((a, b) => a - b));

const chipText = (name: "Status" | "Priority", codes: readonly Code[], labels: readonly string[]) =>
  codes.length === 0 ? name : codes.length === 1 ? labels[codes[0]!]! : `${codes.length} ${name === "Status" ? "statuses" : "priorities"}`;

/** The filter chips, the sort menu, the title search and the button for a new issue. `set` gets every change to the filter. */
export function Toolbar(props: { filter: Filter; total: number | undefined; set(patch: Partial<Filter>): void; create(): void }) {
  const { filter, set } = props;
  const [search, setSearch] = useState("");

  useEffect(() => {
    const q = search.trim();
    if (q === filter.q) return;
    const typing = setTimeout(() => set({ q }), 80);
    return () => clearTimeout(typing);
  }, [search]);

  const codes = (field: "status" | "priority") => codeItems(field, (c) => filter[field].includes(c), (c) => set({ [field]: toggled(filter[field], c) }));
  const sorts: Item[] = [
    { head: "Order by" },
    ...SORTS.map((s): Item => ({ label: <span>{SORT_LABELS[s]}</span>, on: filter.sort === s, pick: () => set({ sort: s }) })),
    "separator",
    { label: <span>Descending</span>, on: filter.dir === "desc", pick: () => set({ dir: "desc" }) },
    { label: <span>Ascending</span>, on: filter.dir === "asc", pick: () => set({ dir: "asc" }) },
  ];

  return (
    <div className="topbar">
      <span className="title">All issues</span>
      <span id="count" className="count mono">
        {props.total?.toLocaleString("en-US")}
      </span>
      <div className="chips">
        <MenuButton className={filter.status.length ? "chip on" : "chip"} title="Filter by status" keepOpen items={codes("status")}>
          {chipText("Status", filter.status, STATUS_LABELS)}
        </MenuButton>
        <MenuButton className={filter.priority.length ? "chip on" : "chip"} title="Filter by priority" keepOpen items={codes("priority")}>
          {chipText("Priority", filter.priority, PRIORITY_LABELS)}
        </MenuButton>
        {(filter.status.length > 0 || filter.priority.length > 0 || filter.q !== "") && (
          <button
            className="chip plain"
            data-clear
            onClick={() => {
              setSearch("");
              set({ status: [], priority: [], q: "" });
            }}
          >
            Clear
          </button>
        )}
        <MenuButton className="chip plain" title="Sort" items={sorts}>
          {`${SORT_LABELS[filter.sort]} ${filter.dir === "desc" ? "↓" : "↑"}`}
        </MenuButton>
      </div>
      <button className="btn primary" id="new" onClick={props.create}>
        New issue
      </button>
      <label className="search">
        <input id="search" type="search" placeholder="Search titles" autoComplete="off" value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
    </div>
  );
}
