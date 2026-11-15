/** The page editor's keys. Each command is DOM-free, so the tests run them on a bare EditorState. */
import { chainCommands, setBlockType, splitBlockAs, toggleMark } from "prosemirror-commands";
import { redo, undo } from "prosemirror-history";
import { undoInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { Node as PMNode } from "prosemirror-model";
import type { Command, Plugin } from "prosemirror-state";
import { schema } from "./schema.ts";

const MAX_DEPTH = 5;
const hasDepth = (node: PMNode) => node.type.name === "item" || node.type.name === "todo";

/** Tab and Shift-Tab: depth +1 or -1, clamped to 0..5, on every item and todo in the selection. Always handled, so focus stays. */
export function indent(delta: 1 | -1): Command {
  return (state, dispatch) => {
    const tr = state.tr;
    const { from, to } = state.selection;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (hasDepth(node)) {
        const depth = Math.max(0, Math.min(MAX_DEPTH, node.attrs.depth + delta));
        if (depth !== node.attrs.depth) tr.setNodeAttribute(pos, "depth", depth);
      }
      return false;
    });
    if (dispatch && tr.docChanged) dispatch(tr);
    return true;
  };
}

/** Enter in an empty item or todo moves it out a level, and at depth 0 out of the list. */
const leaveList: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  const block = $from.parent;
  if (!empty || !hasDepth(block) || block.content.size > 0) return false;
  if (block.attrs.depth > 0) {
    dispatch?.(state.tr.setNodeAttribute($from.before(1), "depth", block.attrs.depth - 1));
    return true;
  }
  return setBlockType(schema.nodes.paragraph!)(state, dispatch);
};

/** An item continues its list at its depth, and a todo continues unchecked. A heading split at its end gives a paragraph. */
const continueBlock = splitBlockAs((node) => {
  if (node.type.name === "item") return { type: node.type, attrs: node.attrs };
  if (node.type.name === "todo") return { type: node.type, attrs: { depth: node.attrs.depth, checked: false } };
  return null;
});

export const enter: Command = chainCommands(leaveList, continueBlock);

/** Backspace at the start of a heading, item or todo turns it into a paragraph and keeps its text. */
export const backspaceToParagraph: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset > 0 || $from.parent.type.name === "paragraph") return false;
  return setBlockType(schema.nodes.paragraph!)(state, dispatch);
};

/** Mod-Enter in a todo, or a click on the checkbox of the todo at `pos`. */
export function toggleTodo(pos?: number): Command {
  return (state, dispatch) => {
    const at = pos ?? (state.selection.$from.depth > 0 ? state.selection.$from.before(1) : -1);
    const node = at >= 0 ? state.doc.nodeAt(at) : null;
    if (node?.type.name !== "todo") return false;
    dispatch?.(state.tr.setNodeAttribute(at, "checked", !node.attrs.checked));
    return true;
  };
}

/**
 * Mod-k: removes every link in the selection, or calls `askHref` so the page can ask for a URL; the answer
 * comes back later through `setLink`, on the selection as it is then.
 */
export function toggleLink(askHref: () => void): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    const link = schema.marks.link!;
    if (empty) return false;
    if (state.doc.rangeHasMark(from, to, link)) {
      dispatch?.(state.tr.removeMark(from, to, link));
      return true;
    }
    if (dispatch) askHref();
    return true;
  };
}

/** Links the selection to `href`, read as https when it names no scheme. A blank URL or an empty selection changes nothing. */
export function setLink(href: string): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    const trimmed = href.trim();
    const url = !trimmed || /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
    if (empty || !url) return false;
    dispatch?.(state.tr.addMark(from, to, schema.marks.link!.create({ href: url })));
    return true;
  };
}

/** Bound before `baseKeymap`, which handles the keys these leave alone. */
export function pageKeymap(askHref: () => void): Plugin {
  return keymap({
    "Mod-b": toggleMark(schema.marks.bold!),
    "Mod-i": toggleMark(schema.marks.italic!),
    "Mod-e": toggleMark(schema.marks.code!),
    "Mod-k": toggleLink(askHref),
    Tab: indent(1),
    "Shift-Tab": indent(-1),
    Enter: enter,
    Backspace: chainCommands(undoInputRule, backspaceToParagraph),
    "Mod-Enter": toggleTodo(),
    "Mod-z": undo,
    "Shift-Mod-z": redo,
    "Mod-y": redo,
  });
}
