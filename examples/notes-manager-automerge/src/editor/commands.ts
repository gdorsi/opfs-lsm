import { chainCommands, setBlockType, splitBlockAs, toggleMark } from "prosemirror-commands";
import { redo, undo } from "prosemirror-history";
import { undoInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { Node as PMNode } from "prosemirror-model";
import type { Command, Plugin } from "prosemirror-state";
import type { PageId } from "../model/types.ts";
import { toggleBlockMenu } from "./menu.ts";
import { openSelectedPage, selectPageAfter, selectPageBefore } from "./pages.ts";
import { schema } from "./schema.ts";

const MAX_DEPTH = 5;
const hasDepth = (node: PMNode) => node.type.name === "item" || node.type.name === "todo";

/** Always handled, so focus stays. */
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

const continueBlock = splitBlockAs((node) => {
  if (node.type.name === "item") return { type: node.type, attrs: node.attrs };
  if (node.type.name === "todo") return { type: node.type, attrs: { depth: node.attrs.depth, checked: false } };
  return null;
});

export const enter: Command = chainCommands(leaveList, continueBlock);

export const backspaceToParagraph: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset > 0 || $from.parent.type.name === "paragraph") return false;
  return setBlockType(schema.nodes.paragraph!)(state, dispatch);
};

export function toggleTodo(pos?: number): Command {
  return (state, dispatch) => {
    const at = pos ?? (state.selection.$from.depth > 0 ? state.selection.$from.before(1) : -1);
    const node = at >= 0 ? state.doc.nodeAt(at) : null;
    if (node?.type.name !== "todo") return false;
    dispatch?.(state.tr.setNodeAttribute(at, "checked", !node.attrs.checked));
    return true;
  };
}

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

export function pageKeymap(askHref: () => void, openPage: (id: PageId) => void): Plugin {
  return keymap({
    "Mod-b": toggleMark(schema.marks.bold!),
    "Mod-i": toggleMark(schema.marks.italic!),
    "Mod-e": toggleMark(schema.marks.code!),
    "Mod-k": toggleLink(askHref),
    Tab: indent(1),
    "Shift-Tab": indent(-1),
    Enter: chainCommands(openSelectedPage(openPage), enter),
    Backspace: chainCommands(undoInputRule, backspaceToParagraph, selectPageBefore),
    Delete: selectPageAfter,
    "Mod-Enter": toggleTodo(),
    "Mod-/": toggleBlockMenu(),
    "Mod-z": undo,
    "Shift-Mod-z": redo,
    "Mod-y": redo,
  });
}
