import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check } from "./icons.tsx";

export type MenuEntry =
  | { readonly kind: "item"; readonly key: string; readonly label: string; readonly icon?: ReactNode; readonly checked?: boolean; onSelect(): void }
  | { readonly kind: "heading"; readonly label: string }
  | { readonly kind: "separator" };

export const item = (key: string, label: string, onSelect: () => void, extra: { icon?: ReactNode; checked?: boolean } = {}): MenuEntry => ({
  kind: "item",
  key,
  label,
  onSelect,
  ...extra,
});

interface MenuButtonProps {
  readonly className: string;
  readonly title?: string;
  readonly entries: readonly MenuEntry[];
  /** Stay open after a pick, for multi-select menus. */
  readonly keepOpen?: boolean;
  readonly children: ReactNode;
}

/** A button that opens a menu in a portal, so no scroller or overflow clips it. */
export function MenuButton({ className, title, entries, keepOpen, children }: MenuButtonProps) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const close = () => setAnchor(null);
  return (
    <>
      <button
        className={className}
        title={title}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={(e) => {
          e.stopPropagation();
          setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect());
        }}
      >
        {children}
      </button>
      {anchor && <Popover anchor={anchor} entries={entries} keepOpen={keepOpen} onClose={close} />}
    </>
  );
}

function Popover({ anchor, entries, keepOpen, onClose }: { anchor: DOMRect; entries: readonly MenuEntry[]; keepOpen?: boolean; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: anchor.bottom + 4, left: anchor.left });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const top = anchor.bottom + 4 + height > innerHeight - 8 ? Math.max(8, anchor.top - height - 4) : anchor.bottom + 4;
    setPos({ top, left: Math.max(8, Math.min(anchor.left, innerWidth - width - 8)) });
    el.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [anchor]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = [...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
        const at = items.indexOf(document.activeElement as HTMLElement);
        items.at((at + (e.key === "ArrowDown" ? 1 : -1)) % items.length)?.focus();
      }
    };
    document.addEventListener("mousedown", down, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [onClose]);

  return createPortal(
    <div ref={ref} className="menu" role="menu" style={pos} onClick={(e) => e.stopPropagation()}>
      {entries.map((e, i) =>
        e.kind === "separator" ? (
          <div key={i} className="menu-sep" />
        ) : e.kind === "heading" ? (
          <div key={i} className="menu-head">
            {e.label}
          </div>
        ) : (
          <button
            key={e.key}
            role="menuitem"
            className="menu-item"
            onClick={() => {
              e.onSelect();
              if (!keepOpen) onClose();
            }}
          >
            {e.icon}
            <span>{e.label}</span>
            <span className="tick">{e.checked && <Check />}</span>
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
