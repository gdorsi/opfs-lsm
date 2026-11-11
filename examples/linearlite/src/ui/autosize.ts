import { useLayoutEffect, type RefObject } from "react";

/** Grows a textarea to fit its text. */
export function useAutosize(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [ref, value]);
}
