import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, PriorityIcon, StatusIcon } from "./icons.tsx";
import { CODES, PRIORITY_LABELS, STATUS_LABELS, type Code } from "./model.ts";

export type Item = { readonly label: ReactNode; readonly on: boolean; pick(): void } | { readonly head: string } | "separator";

/**
 * A button that opens a menu under itself. A pick closes the menu, unless `keepOpen`: a menu of toggles stays open
 * and shows the items of the next render.
 */
export function MenuButton(props: { className: string; title: string; keepOpen?: boolean; items: Item[]; children: ReactNode }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={anchor}
        className={props.className}
        title={props.title}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        {props.children}
      </button>
      {open && <Menu anchor={anchor.current!} items={props.items} keepOpen={props.keepOpen ?? false} close={() => setOpen(false)} />}
    </>
  );
}

function Menu({ anchor, items, keepOpen, close }: { anchor: HTMLElement; items: Item[]; keepOpen: boolean; close(): void }) {
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number }>();

  useLayoutEffect(() => {
    const box = anchor.getBoundingClientRect();
    setPlace({ top: box.bottom + 4, left: Math.max(8, Math.min(box.left, innerWidth - menu.current!.offsetWidth - 8)) });
  }, [anchor]);

  useEffect(() => {
    const outside = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== "Escape") return;
        // The menu takes the key, so the page or dialog under it stays open.
        e.stopPropagation();
        close();
      } else if (!menu.current!.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
    };
    addEventListener("pointerdown", outside, true);
    addEventListener("keydown", outside, true);
    return () => {
      removeEventListener("pointerdown", outside, true);
      removeEventListener("keydown", outside, true);
    };
  }, [anchor, close]);

  return createPortal(
    // A click in the menu stays in it: the list row it may sit in opens the issue on a click.
    <div ref={menu} className="menu" role="menu" style={place} onClick={(e) => e.stopPropagation()}>
      {items.map((item, i) =>
        item === "separator" ? (
          <div key={i} className="menu-sep" />
        ) : "head" in item ? (
          <div key={i} className="menu-head">
            {item.head}
          </div>
        ) : (
          <button
            key={i}
            className="menu-item"
            role="menuitem"
            onClick={() => {
              item.pick();
              if (!keepOpen) close();
            }}
          >
            {item.label}
            <span className="tick">{item.on && <Check />}</span>
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/** The items of a menu that picks one status or one priority. */
export const codeItems = (field: "status" | "priority", on: (code: Code) => boolean, pick: (code: Code) => void): Item[] =>
  CODES.map((c) => ({ label: <CodeLabel field={field} code={c} />, on: on(c), pick: () => pick(c) }));

/** A status or a priority as its icon and its name. */
export const CodeLabel = ({ field, code }: { field: "status" | "priority"; code: Code }) =>
  field === "status" ? (
    <>
      <StatusIcon code={code} />
      <span>{STATUS_LABELS[code]}</span>
    </>
  ) : (
    <>
      <PriorityIcon code={code} />
      <span>{PRIORITY_LABELS[code]}</span>
    </>
  );
