import type { Direction, Style } from "../../model/index.ts";

export type Tool = "select" | "rect" | "ellipse" | "diamond" | "arrow" | "text" | "pen";

export type Action =
  | { readonly type: "tool"; readonly tool: Tool }
  | { readonly type: "undo" }
  | { readonly type: "redo" }
  | { readonly type: "delete" }
  | { readonly type: "duplicate" }
  | { readonly type: "reorder"; readonly to: Direction }
  | { readonly type: "nudge"; readonly dx: number; readonly dy: number }
  | { readonly type: "style"; readonly edit: Partial<Style> }
  | { readonly type: "selectAll" }
  | { readonly type: "editText" }
  | { readonly type: "zoom"; readonly to: "in" | "out" | "reset" | "fit" };

export type KeySample = {
  readonly key: string;
  readonly mod: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly repeat: boolean;
};

export const TOOL_KEYS: Readonly<Record<Tool, string>> = { select: "v", rect: "r", ellipse: "o", diamond: "d", arrow: "a", text: "t", pen: "p" };
const NUDGE = 1;
const NUDGE_SHIFT = 10;

const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export const isArrowKey = (key: string): boolean => key in ARROWS;

export function keyAction(k: KeySample): Action | undefined {
  const key = k.key.length === 1 ? k.key.toLowerCase() : k.key;
  if (k.mod) {
    if (key === "z") return { type: k.shift ? "redo" : "undo" };
    if (key === "y") return { type: "redo" };
    if (key === "a") return { type: "selectAll" };
    if (key === "d") return { type: "duplicate" };
    if (key === "]" || key === "}") return { type: "reorder", to: k.shift ? "front" : "forward" };
    if (key === "[" || key === "{") return { type: "reorder", to: k.shift ? "back" : "backward" };
    if (key === "0") return { type: "zoom", to: "reset" };
    if (key === "=" || key === "+") return { type: "zoom", to: "in" };
    if (key === "-") return { type: "zoom", to: "out" };
    return undefined;
  }
  if (k.shift && (key === "1" || key === "!")) return { type: "zoom", to: "fit" };
  if (key === "Delete" || key === "Backspace") return { type: "delete" };
  const arrow = ARROWS[key];
  if (arrow) {
    const step = k.shift ? NUDGE_SHIFT : NUDGE;
    return { type: "nudge", dx: arrow[0] * step, dy: arrow[1] * step };
  }
  if (key === "Enter") return { type: "editText" };
  if (!k.shift && !k.alt && !k.repeat) {
    for (const tool of Object.keys(TOOL_KEYS) as Tool[]) if (TOOL_KEYS[tool] === key) return { type: "tool", tool };
  }
  return undefined;
}
