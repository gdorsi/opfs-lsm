import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { BoardMeta, SaveState, Workspace } from "../model/index.ts";
import { useWorkspace } from "./hooks.ts";
import { Icon, ICON, Mark } from "./icons.tsx";
import type { StorageKind } from "./session.ts";

export const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function editable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

export type Shortcut = { readonly label: string; readonly aria: string };

const MODIFIERS = ["Mod", "Alt", "Shift"] as const;
const MAC_GLYPH: Readonly<Record<string, string>> = { Mod: "⌘", Alt: "⌥", Shift: "⇧", Delete: "⌫", "=": "+" };
const PC_NAME: Readonly<Record<string, string>> = { Mod: "Ctrl", Delete: "Del", "=": "+" };
const MAC_ORDER = ["Alt", "Shift", "Mod"];

export function keys(...parts: string[]): Shortcut {
  const mods = parts.filter((p) => (MODIFIERS as readonly string[]).includes(p));
  const key = parts.filter((p) => !mods.includes(p));
  const label = MAC
    ? [...mods.sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b)), ...key].map((p) => MAC_GLYPH[p] ?? p).join("")
    : [...mods, ...key].map((p) => PC_NAME[p] ?? p).join("+");
  const aria = [...mods, ...key].map((p) => (p === "Mod" ? (MAC ? "Meta" : "Control") : p === "Esc" ? "Escape" : p)).join("+");
  return { label, aria };
}

type IconButtonProps = {
  readonly label: string;
  readonly tip?: string;
  readonly icon: ReactNode;
  readonly shortcut?: Shortcut;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label">;

export function IconButton({ label, tip = label, icon, shortcut, className, ...rest }: IconButtonProps): ReactNode {
  return (
    <button
      type="button"
      className={className ? `icon-btn ${className}` : "icon-btn"}
      aria-label={label}
      aria-keyshortcuts={shortcut?.aria}
      data-tip={tip}
      data-keys={shortcut?.label}
      {...rest}
    >
      <Icon>{icon}</Icon>
    </button>
  );
}

const TIP_DELAY_MS = 450;
const TIP_WARM_MS = 400;

export function Tooltips(): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const tip = ref.current!;
    let timer = 0;
    let shown: HTMLElement | null = null;
    let hiddenAt = 0;

    const place = (target: HTMLElement) => {
      tip.replaceChildren(target.dataset.tip ?? "");
      if (target.dataset.keys) {
        const kbd = document.createElement("kbd");
        kbd.textContent = target.dataset.keys;
        tip.append(kbd);
      }
      tip.hidden = false;
      const r = target.getBoundingClientRect();
      const below = target.dataset.tipSide === "below" || (target.dataset.tipSide !== "above" && r.top < innerHeight / 2);
      const top = below ? r.bottom + 8 : r.top - tip.offsetHeight - 8;
      const left = Math.min(Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2), innerWidth - tip.offsetWidth - 8);
      tip.style.translate = `${Math.round(left)}px ${Math.round(top)}px`;
      shown = target;
    };
    const hide = () => {
      clearTimeout(timer);
      if (shown) hiddenAt = performance.now();
      shown = null;
      tip.hidden = true;
    };
    const tipTarget = (e: Event) => (e.target instanceof Element ? e.target.closest<HTMLElement>("[data-tip]") : null);

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const target = tipTarget(e);
      if (target === shown) return;
      hide();
      if (!target) return;
      const warm = performance.now() - hiddenAt < TIP_WARM_MS;
      timer = window.setTimeout(() => place(target), warm ? 0 : TIP_DELAY_MS);
    };
    const onFocus = (e: FocusEvent) => {
      const target = tipTarget(e);
      if (target?.matches(":focus-visible")) place(target);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();

    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", hide);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);
  return <div ref={ref} className="tooltip" aria-hidden="true" hidden />;
}

export function SaveStatus({ state, skipped, retry }: { state: SaveState; skipped: number; retry: () => Promise<unknown> }): ReactNode {
  return (
    <span className="save" role="status" data-state={state.kind}>
      <Icon size={16}>{state.kind === "error" ? ICON.alert : state.kind === "saving" ? ICON.saving : ICON.saved}</Icon>
      <span className="save-text">
        {state.kind === "saved" && "Saved"}
        {state.kind === "saving" && "Saving…"}
        {state.kind === "error" && (
          <>
            Not saved<span className="save-detail">: {state.error.message}</span>
          </>
        )}
        {skipped > 0 && ` · ${skipped} unreadable`}
      </span>
      {state.kind === "error" && (
        <button type="button" className="btn small" onClick={() => void retry().catch(() => {})}>
          Retry
        </button>
      )}
    </span>
  );
}

export function WorkspaceSaveBadge({ ws }: { ws: Workspace }): ReactNode {
  const { save } = useWorkspace(ws);
  return <SaveStatus state={save} skipped={0} retry={() => ws.flush()} />;
}

export function StorageChip({ storage }: { storage: StorageKind }): ReactNode {
  return (
    <span className="chip" data-tip={storage === "kv" ? "Stored with @opfs-lsm/kv on OPFS" : "Stored with y-indexeddb"}>
      <Icon size={14}>{ICON.storage}</Icon>
      {storage === "kv" ? "OPFS (kv)" : "IndexedDB"}
    </span>
  );
}

export function TitleInput({ ws, meta, onDone, className }: { ws: Workspace; meta: BoardMeta; onDone: () => void; className: string }): ReactNode {
  const [draft, setDraft] = useState(meta.title);
  const cancelled = useRef(false);
  const commit = () => {
    const title = draft.trim();
    if (!cancelled.current && title !== "" && title !== meta.title) ws.renameBoard(meta.id, title);
    onDone();
  };
  return (
    <input
      className={className}
      value={draft}
      autoFocus
      maxLength={120}
      aria-label="Board name"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          cancelled.current = true;
          onDone();
        }
      }}
    />
  );
}

type MessageProps = { readonly title: string; readonly children: ReactNode; readonly action: ReactNode; readonly alert?: boolean };

export function MessagePage({ title, children, action, alert }: MessageProps): ReactNode {
  return (
    <main className="message-page" role={alert ? "alert" : undefined}>
      <svg className="message-art" viewBox="0 0 160 96" aria-hidden="true">
        <rect x="28" y="12" width="104" height="68" rx="9" strokeDasharray="6 7" />
        <path d="M76 32l22 13.2-10.3 2.9-4.4 10.3z" fill="var(--surface)" />
      </svg>
      <h1>{title}</h1>
      <div className="message-body">{children}</div>
      {action}
    </main>
  );
}

export function Splash({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="splash" role="status">
      <Mark size={32} />
      <span>{children}</span>
    </div>
  );
}
