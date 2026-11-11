import { useEffect, useRef, useState } from "react";
import { SORT_FIELDS, type IssueFilter, type SortField } from "../client/filter.ts";
import { PRIORITY_LABELS, STATUS_LABELS, type PriorityCode, type StatusCode } from "../domain/model.ts";
import { PriorityIcon, StatusIcon } from "./icons.tsx";
import { item, MenuButton, type MenuEntry } from "./menu.tsx";
import { useSetFilter } from "./nav.ts";

const SORT_LABELS: Record<SortField, string> = { modified: "Modified", created: "Created", priority: "Priority", status: "Status", title: "Title" };
const CODES = [0, 1, 2, 3, 4] as const;

const toggle = <T extends number>(list: readonly T[], code: T): T[] => (list.includes(code) ? list.filter((c) => c !== code) : [...list, code].sort());

function summarize(labels: readonly string[], picked: readonly number[], none: string): string {
  if (picked.length === 0) return none;
  return picked.length <= 2 ? picked.map((c) => labels[c]).join(", ") : `${picked.length} selected`;
}

export function Toolbar({ title, count, filter }: { title: string; count: number; filter: IssueFilter }) {
  const setFilter = useSetFilter();
  const active = filter.status.length > 0 || filter.priority.length > 0 || filter.q !== "";

  const statusEntries: MenuEntry[] = CODES.map((c: StatusCode) =>
    item(`s${c}`, STATUS_LABELS[c], () => setFilter({ status: toggle(filter.status, c) }), { icon: <StatusIcon status={c} />, checked: filter.status.includes(c) }),
  );
  const priorityEntries: MenuEntry[] = CODES.map((c: PriorityCode) =>
    item(`p${c}`, PRIORITY_LABELS[c], () => setFilter({ priority: toggle(filter.priority, c) }), { icon: <PriorityIcon priority={c} />, checked: filter.priority.includes(c) }),
  );
  const sortEntries: MenuEntry[] = [
    { kind: "heading", label: "Order by" },
    ...SORT_FIELDS.map((f) => item(f, SORT_LABELS[f], () => setFilter({ sort: f }), { checked: filter.sort === f })),
    { kind: "separator" },
    item("desc", "Descending", () => setFilter({ dir: "desc" }), { checked: filter.dir === "desc" }),
    item("asc", "Ascending", () => setFilter({ dir: "asc" }), { checked: filter.dir === "asc" }),
  ];

  return (
    <div className="topbar">
      <span className="title">{title}</span>
      <span className="count mono" id="count" aria-live="polite">
        {count.toLocaleString()}
      </span>
      <div className="chips">
        <MenuButton className={`chip${filter.status.length ? " on" : ""}`} entries={statusEntries} keepOpen title="Filter by status">
          Status{filter.status.length > 0 && `: ${summarize(STATUS_LABELS, filter.status, "")}`}
        </MenuButton>
        <MenuButton className={`chip${filter.priority.length ? " on" : ""}`} entries={priorityEntries} keepOpen title="Filter by priority">
          Priority{filter.priority.length > 0 && `: ${summarize(PRIORITY_LABELS, filter.priority, "")}`}
        </MenuButton>
        {active && (
          <button className="chip plain" onClick={() => setFilter({ status: [], priority: [], q: "" })}>
            Clear
          </button>
        )}
      </div>
      <MenuButton className="chip plain" entries={sortEntries} title="Sort">
        {SORT_LABELS[filter.sort]} {filter.dir === "desc" ? "↓" : "↑"}
      </MenuButton>
      <SearchBox q={filter.q} />
    </div>
  );
}

const DEBOUNCE_MS = 80;

function SearchBox({ q }: { q: string }) {
  const setFilter = useSetFilter();
  const [text, setText] = useState(q);
  const sent = useRef(q);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (q === sent.current) return;
    sent.current = q;
    setText(q);
  }, [q]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <div className="search">
      <input
        id="search"
        type="search"
        placeholder="Search titles"
        value={text}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            sent.current = next;
            setFilter({ q: next }, true);
          }, DEBOUNCE_MS);
        }}
      />
      {text === "" && <kbd>/</kbd>}
    </div>
  );
}
