/**
 * Page blocks: a sub-page shown in its parent's body. The list doc owns which
 * pages exist and under which parent; a page block only places one. These
 * functions keep the two agreeing, and run in Node tests.
 */
import type { Node as PMNode } from "prosemirror-model";
import { NodeSelection, TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import type { PageId } from "../model/types.ts";
import { schema } from "./schema.ts";

const page = schema.nodes.page!;
const paragraph = schema.nodes.paragraph!;

/** Marks the editor's own repairs: they may remove page blocks, and never enter the undo history. */
const FIX = "pages:fix";

export const isPageFix = (tr: Transaction): boolean => tr.getMeta(FIX) === true;

type PageBlock = { readonly id: PageId; readonly pos: number; readonly node: PMNode };

/** Every page block, in order. They sit at the top level only. */
export function pageBlocks(doc: PMNode): PageBlock[] {
  const out: PageBlock[] = [];
  doc.forEach((node, pos) => {
    if (node.type === page) out.push({ id: node.attrs.id, pos, node });
  });
  return out;
}

function touchesPage(tr: Transaction): boolean {
  return tr.steps.some((step, i) => {
    let hit = false;
    step.getMap().forEach((from, to) => {
      if (hit || to <= from) return;
      tr.docs[i]!.nodesBetween(from, to, (node) => {
        if (node.type === page) hit = true;
        return false;
      });
    });
    return hit;
  });
}

/**
 * The children whose last block `tr` removes. A move keeps the id, so it
 * removes nothing; a block of a page that is not a child goes freely.
 */
export function removedPages(tr: Transaction, isChild: (id: PageId) => boolean): PageId[] {
  if (!tr.docChanged || !touchesPage(tr)) return [];
  const after = new Set(pageBlocks(tr.doc).map((block) => block.id));
  return [...new Set(pageBlocks(tr.before).map((block) => block.id))].filter((id) => isChild(id) && !after.has(id));
}

export type PageFix = {
  /** The page's reachable children. */
  readonly children: readonly PageId[];
  /** Children that just left the tree: their blocks go. */
  readonly gone?: ReadonlySet<PageId>;
  /**
   * On open, also drop the block of every page that is not a child, and add
   * one at the end for each child without a block.
   */
  readonly open?: boolean;
};

/**
 * The repair that makes the body agree with the list, or null. Always: a
 * page's second block goes, text after a page marker becomes a paragraph, and
 * a body never ends with a page block, so there is a line to type on.
 */
export function fixPages(state: EditorState, fix: PageFix): Transaction | null {
  const children = new Set(fix.children);
  const placed = new Set<PageId>();
  const drop: PageBlock[] = [];
  const split: PageBlock[] = [];
  for (const block of pageBlocks(state.doc)) {
    if (placed.has(block.id) || fix.gone?.has(block.id) || (fix.open && !children.has(block.id))) drop.push(block);
    else {
      placed.add(block.id);
      if (block.node.content.size > 0) split.push(block);
    }
  }
  const tr = state.tr;
  // Back to front, so each position is still the one read above.
  for (const block of [...drop, ...split].sort((a, b) => b.pos - a.pos)) {
    if (drop.includes(block)) tr.delete(block.pos, block.pos + block.node.nodeSize);
    else tr.split(block.pos + 1, 1, [{ type: paragraph }]);
  }
  if (fix.open) {
    const missing = fix.children.filter((id) => !placed.has(id));
    if (missing.length > 0) tr.insert(tr.doc.content.size, missing.map((id) => page.create({ id })));
  }
  if (tr.doc.lastChild!.type === page) tr.insert(tr.doc.content.size, paragraph.create());
  return tr.docChanged ? tr.setMeta(FIX, true).setMeta("addToHistory", false) : null;
}

/**
 * Puts a block for page `id` at the block holding `pos`: in its place when it
 * is empty, else after it. A paragraph follows when the page would end the body.
 */
export function insertPageBlock(tr: Transaction, pos: number, id: PageId): Transaction {
  const $pos = tr.doc.resolve(pos);
  const start = $pos.before(1);
  let end: number;
  if ($pos.parent.content.size === 0) {
    tr.setNodeMarkup(start, page, { id });
    end = start + 2;
  } else {
    end = $pos.after(1);
    tr.insert(end, page.create({ id }));
    end += 2;
  }
  if (end === tr.doc.content.size) tr.insert(end, paragraph.create());
  return tr.setSelection(NodeSelection.create(tr.doc, end - 2));
}

const caret = (state: EditorState) => (state.selection instanceof TextSelection ? state.selection.$cursor : null);

/** Backspace at the start of the block after a page block selects the page; an empty block that is not the last goes. */
export const selectPageBefore: Command = (state, dispatch) => {
  const $cursor = caret(state);
  if (!$cursor || $cursor.depth !== 1 || $cursor.parentOffset > 0) return false;
  const index = $cursor.index(0);
  const before = index > 0 ? state.doc.child(index - 1) : null;
  if (before?.type !== page) return false;
  if (dispatch) {
    const start = $cursor.before(1);
    const tr = state.tr;
    if ($cursor.parent.content.size === 0 && index < state.doc.childCount - 1) tr.delete(start, $cursor.after(1));
    dispatch(tr.setSelection(NodeSelection.create(tr.doc, start - before.nodeSize)).scrollIntoView());
  }
  return true;
};

/** Delete at the end of the block before a page block selects the page; an empty block goes. */
export const selectPageAfter: Command = (state, dispatch) => {
  const $cursor = caret(state);
  if (!$cursor || $cursor.depth !== 1 || $cursor.parentOffset < $cursor.parent.content.size) return false;
  const index = $cursor.index(0);
  const after = index + 1 < state.doc.childCount ? state.doc.child(index + 1) : null;
  if (after?.type !== page) return false;
  if (dispatch) {
    const tr = state.tr;
    let at = $cursor.after(1);
    if ($cursor.parent.content.size === 0) {
      tr.delete($cursor.before(1), at);
      at = $cursor.before(1);
    }
    dispatch(tr.setSelection(NodeSelection.create(tr.doc, at)).scrollIntoView());
  }
  return true;
};

/** Enter on a selected page block opens the page. */
export function openSelectedPage(open: (id: PageId) => void): Command {
  return (state, dispatch) => {
    const { selection } = state;
    if (!(selection instanceof NodeSelection) || selection.node.type !== page) return false;
    if (dispatch) open(selection.node.attrs.id);
    return true;
  };
}

/** From the title: a caret at the top of the body, on a new first line when the body starts with a page block. */
export const caretAtTop: Command = (state, dispatch) => {
  if (dispatch) {
    const tr = state.tr;
    if (state.doc.firstChild!.type === page) tr.insert(0, paragraph.create());
    dispatch(tr.setSelection(TextSelection.create(tr.doc, 1)).scrollIntoView());
  }
  return true;
};
