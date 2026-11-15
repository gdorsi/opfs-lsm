/**
 * The keymap: one table from a key to an Action. Pure. The DOM boundary resolves `mod` (meta on macOS, ctrl
 * elsewhere) and drops keys typed into an input, a textarea or a contenteditable before they get here.
 * Space, Escape, Shift and Alt are not actions: the controller reads them as state (see input.ts).
 */
import type { Direction, Style } from "../../model/index.ts";

export type Tool = "select" | "rect" | "ellipse" | "diamond" | "arrow" | "text" | "pen";

/** What a key or a toolbar button asks for. The one vocabulary of board commands in the app. */
export type Action =
  | { readonly type: "tool"; readonly tool: Tool }
  | { readonly type: "undo" }
  | { readonly type: "redo" }
  | { readonly type: "delete" }
  | { readonly type: "duplicate" }
  | { readonly type: "reorder"; readonly to: Direction }
  /** Moves the selection. A held key is one gesture, so one undo step: see the nudge phase in input.ts. */
  | { readonly type: "nudge"; readonly dx: number; readonly dy: number }
  /** Applies to the selection, and becomes the style of the next shape drawn. */
  | { readonly type: "style"; readonly edit: Partial<Style> }
  | { readonly type: "selectAll" }
  | { readonly type: "editText" }
  | { readonly type: "zoom"; readonly to: "in" | "out" | "reset" | "fit" };

export type KeySample = {
  /** KeyboardEvent.key, e.g. "z", "Z", "ArrowLeft", "Delete", " ". */
  readonly key: string;
  readonly mod: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly repeat: boolean;
};

/**
 * Every tool and its key, in toolbar order. The keymap inverts it and the toolbar renders from it, so there is one
 * list; typed by Tool, so a new tool fails the build until it has a key.
 */
export const TOOL_KEYS: Readonly<Record<Tool, string>> = { select: "v", rect: "r", ellipse: "o", diamond: "d", arrow: "a", text: "t", pen: "p" };
const NUDGE = 1;
const NUDGE_SHIFT = 10;

const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** The arrow keys a nudge reads. The controller ends a nudge when the last one is released. */
export const isArrowKey = (key: string): boolean => key in ARROWS;

/** The action of a key press, or undefined when the browser keeps the key. First match wins. */
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
