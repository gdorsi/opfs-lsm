import { useEffect, type RefObject } from "react";

/** Calls `onClose` on a pointer down outside `ref`, or on Escape. */
export function useDismiss(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  useEffect(() => {
    const away = (event: Event) => ref.current && !ref.current.contains(event.target as Node) && onClose();
    const escape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [ref, onClose]);
}
