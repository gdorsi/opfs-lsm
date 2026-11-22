import { Portal, type JSX } from "@solidjs/web";
import { createSignal, For, onSettled, Show, type ParentProps } from "solid-js";
import { Check, PriorityIcon, StatusIcon } from "./icons.tsx";
import { CODES, PRIORITY_LABELS, STATUS_LABELS, type Code } from "./model.ts";

type Choice = { readonly label: () => JSX.Element; readonly on: boolean; pick(): void };
export type Item = Choice | { readonly head: string } | "separator";

/**
 * A button that opens a menu under itself. A pick closes the menu, unless `keepOpen`: a menu of toggles stays open
 * and shows the items as they are after the pick. `label` names a button that holds only an icon.
 */
export function MenuButton(props: ParentProps<{ class: JSX.ClassValue; title: string; label?: string; keepOpen?: boolean; items: Item[] }>) {
  let anchor!: HTMLButtonElement;
  const [open, setOpen] = createSignal(false);
  return (
    <>
      <button
        ref={(el) => (anchor = el)}
        class={props.class}
        title={props.title}
        aria-label={props.label}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        {props.children}
      </button>
      <Show when={open()}>
        <Menu anchor={anchor} items={props.items} keepOpen={props.keepOpen ?? false} close={() => setOpen(false)} />
      </Show>
    </>
  );
}

function Menu(props: { anchor: HTMLElement; items: Item[]; keepOpen: boolean; close(): void }) {
  let menu!: HTMLDivElement;
  const [place, setPlace] = createSignal<{ top: string; left: string }>();

  onSettled(() => {
    const box = props.anchor.getBoundingClientRect();
    setPlace({ top: `${box.bottom + 4}px`, left: `${Math.max(8, Math.min(box.left, innerWidth - menu.offsetWidth - 8))}px` });
    const outside = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== "Escape") return;
        // The menu takes the key, so the page or dialog under it stays open.
        e.stopPropagation();
        props.close();
      } else if (!menu.contains(e.target as Node) && !props.anchor.contains(e.target as Node)) props.close();
    };
    addEventListener("pointerdown", outside, true);
    addEventListener("keydown", outside, true);
    return () => {
      removeEventListener("pointerdown", outside, true);
      removeEventListener("keydown", outside, true);
    };
  });

  const pick = (choice: Choice) => {
    choice.pick();
    if (!props.keepOpen) props.close();
  };

  return (
    <Portal>
      {/* A click in the menu stays in it: the list row it may sit in opens the issue on a click. */}
      <div ref={(el) => (menu = el)} class="menu" role="menu" style={place()} onClick={(e) => e.stopPropagation()}>
        <For each={props.items} keyed={false}>
          {(item) => <Entry item={item()} pick={pick} />}
        </For>
      </div>
    </Portal>
  );
}

function Entry(props: { item: Item; pick(choice: Choice): void }) {
  return props.item === "separator" ? (
    <div class="menu-sep" />
  ) : "head" in props.item ? (
    <div class="menu-head">{props.item.head}</div>
  ) : (
    <ChoiceItem choice={props.item} pick={props.pick} />
  );
}

const ChoiceItem = (props: { choice: Choice; pick(choice: Choice): void }) => (
  <button class="menu-item" role="menuitem" onClick={() => props.pick(props.choice)}>
    {props.choice.label()}
    <span class="tick">
      <Show when={props.choice.on}>
        <Check />
      </Show>
    </span>
  </button>
);

/** The items of a menu that picks one status or one priority. */
export const codeItems = (field: "status" | "priority", on: (code: Code) => boolean, pick: (code: Code) => void): Item[] =>
  CODES.map((c) => ({ label: () => <CodeLabel field={field} code={c} />, on: on(c), pick: () => pick(c) }));

/** A status or a priority as its icon and its name. */
export const CodeLabel = (props: { field: "status" | "priority"; code: Code }) => (
  <>
    {props.field === "status" ? <StatusIcon code={props.code} /> : <PriorityIcon code={props.code} />}
    <span>{(props.field === "status" ? STATUS_LABELS : PRIORITY_LABELS)[props.code]}</span>
  </>
);
