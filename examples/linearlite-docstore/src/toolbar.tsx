import { createEffect, createMemo, createSignal, onSettled, Show } from "solid-js";
import { Dots } from "./icons.tsx";
import { codeItems, MenuButton, type Item } from "./menu.tsx";
import { PRIORITY_LABELS, SORTS, SORT_LABELS, STATUS_LABELS, type Code, type Filter } from "./model.ts";

const toggled = (codes: readonly Code[], code: Code) => (codes.includes(code) ? codes.filter((c) => c !== code) : [...codes, code].sort((a, b) => a - b));

const chipText = (name: "Status" | "Priority", codes: readonly Code[], labels: readonly string[]) =>
  codes.length === 0 ? name : codes.length === 1 ? labels[codes[0]!]! : `${codes.length} ${name === "Status" ? "statuses" : "priorities"}`;

const TWEEN_MS = 250;

// Ease-out quint, the curve of the opacity transition on `.count` in app.css.
const easeOut = (t: number) => 1 - (1 - t) ** 5;

/**
 * The issue total. While a count runs the last total stays on screen, dimmed. A new total is counted up or down from
 * the number on screen, so a total that changes many times a second keeps moving instead of restarting.
 */
function Total(props: { total: number | undefined }) {
  const target = createMemo<number | undefined>((last) => props.total ?? last);
  const counting = () => props.total === undefined && target() !== undefined;
  const [shown, setShown] = createSignal<number>();
  // The number on screen, as a plain variable: an effect callback is not a tracking scope, so reading `shown` there warns.
  let current: number | undefined;
  const show = (n: number) => setShown((current = n));

  createEffect(target, (to) => {
    if (to === undefined) return;
    const from = current;
    if (from === undefined || from === to || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      show(to);
      return;
    }
    let start: number | undefined;
    let frame = 0;
    const step = (now: number) => {
      start ??= now;
      const t = Math.min((now - start) / TWEEN_MS, 1);
      show(t === 1 ? to : Math.round(from + (to - from) * easeOut(t)));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  });

  return (
    <span id="count" class={["count", "mono", { counting: counting() }]}>
      {shown()?.toLocaleString("en-US")}
    </span>
  );
}

/**
 * The filter chips, the sort menu, the button for a new issue, the `data` menu and the title search. `set` gets every
 * change to the filter. `progress`, a CSS width, draws a bar along the toolbar's edge.
 */
export function Toolbar(props: {
  filter: Filter;
  total: number | undefined;
  data: Item[];
  progress: string | undefined;
  set(patch: Partial<Filter>): void;
  create(): void;
}) {
  const [search, setSearch] = createSignal("");
  let typing: ReturnType<typeof setTimeout> | undefined;
  onSettled(() => () => clearTimeout(typing));

  const type = (text: string) => {
    setSearch(text);
    clearTimeout(typing);
    typing = setTimeout(() => {
      const q = text.trim();
      if (q !== props.filter.q) props.set({ q });
    }, 80);
  };
  const clear = () => {
    clearTimeout(typing);
    setSearch("");
    props.set({ status: [], priority: [], q: "" });
  };

  const codes = (field: "status" | "priority") =>
    codeItems(field, (c) => props.filter[field].includes(c), (c) => props.set({ [field]: toggled(props.filter[field], c) }));
  const sorts = (): Item[] => [
    { head: "Order by" },
    ...SORTS.map((s): Item => ({ label: () => <span>{SORT_LABELS[s]}</span>, on: props.filter.sort === s, pick: () => props.set({ sort: s }) })),
    "separator",
    { label: () => <span>Descending</span>, on: props.filter.dir === "desc", pick: () => props.set({ dir: "desc" }) },
    { label: () => <span>Ascending</span>, on: props.filter.dir === "asc", pick: () => props.set({ dir: "asc" }) },
  ];

  return (
    <div class="topbar">
      <span class="title">All issues</span>
      <Total total={props.total} />
      <div class="chips">
        <MenuButton class={["chip", { on: props.filter.status.length > 0 }]} title="Filter by status" keepOpen items={codes("status")}>
          {chipText("Status", props.filter.status, STATUS_LABELS)}
        </MenuButton>
        <MenuButton class={["chip", { on: props.filter.priority.length > 0 }]} title="Filter by priority" keepOpen items={codes("priority")}>
          {chipText("Priority", props.filter.priority, PRIORITY_LABELS)}
        </MenuButton>
        <Show when={props.filter.status.length > 0 || props.filter.priority.length > 0 || props.filter.q !== ""}>
          <button class="chip plain" data-clear onClick={clear}>
            Clear
          </button>
        </Show>
        <MenuButton class="chip plain" title="Sort" items={sorts()}>
          {`${SORT_LABELS[props.filter.sort]} ${props.filter.dir === "desc" ? "↓" : "↑"}`}
        </MenuButton>
      </div>
      <button class="btn primary" id="new" onClick={() => props.create()}>
        New issue
      </button>
      <MenuButton class="btn icon" title="Data" label="Data" items={props.data}>
        <Dots />
      </MenuButton>
      <label class="search">
        <input id="search" type="search" placeholder="Search titles" autocomplete="off" value={search()} onInput={(e) => type(e.currentTarget.value)} />
      </label>
      <Show when={props.progress}>
        {(width) => (
          <div class="bar">
            <i style={{ width: width() }} />
          </div>
        )}
      </Show>
    </div>
  );
}
