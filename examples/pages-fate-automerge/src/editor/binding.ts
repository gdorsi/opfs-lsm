/**
 * ProseMirror steps to the model's TextEdits and back, in O(edit).
 *
 * Positions: inside block k, or at the boundary before it, the Automerge index
 * of PM position p is `p - k` (each block marker counts one, each block's open
 * and close tokens two). Between transactions, `docToSpans(state.doc)` equals
 * `body.spans()`.
 */
import type { Fragment, Node as PMNode, Slice } from "prosemirror-model";
import { EditorState, type Plugin, type Transaction } from "prosemirror-state";
import { AddMarkStep, AttrStep, RemoveMarkStep, ReplaceAroundStep, ReplaceStep, type Step } from "prosemirror-transform";
import type { Block, MarkEdit, MarkName, Marks, PageBody, TextEdit } from "../model/types.ts";
import { blockOf, markOf, marksOf, nodeTypeOf, pmMarks, schema, spansToDoc } from "./schema.ts";

/** Meta on a transaction built from a peer's edits: it is already in the body, so it is not translated back. */
const REMOTE = "pages:remote";

/** A step this schema cannot produce (no wrappers, node marks or doc attrs). The dispatch that holds it is refused. */
export class UnsupportedStep extends Error {
  constructor(step: Step) {
    super(`the editor cannot store a ${step.constructor.name}`);
    this.name = "UnsupportedStep";
  }
}

/** The editor state for an open body. The only `spans()` call of the editor's life. */
export function bodyState(body: Pick<PageBody, "spans">, plugins: readonly Plugin[] = []): EditorState {
  return EditorState.create({ doc: spansToDoc(body.spans()), plugins: [...plugins] });
}

/**
 * One dispatch: its local steps, including those plugins append, become one
 * `body.edit`, then PM takes the new state. When translation or the edit
 * throws, nothing changed in the body, and the caller keeps `state`.
 */
export function applyLocal(body: Pick<PageBody, "edit">, state: EditorState, tr: Transaction): EditorState {
  const { state: next, transactions } = state.applyTransaction(tr);
  body.edit(transactions.filter((t) => t.docChanged && !t.getMeta(REMOTE)).flatMap(localEdits));
  return next;
}

export function localEdits(tr: Transaction): TextEdit[] {
  return tr.steps.flatMap((step, i) => stepEdits(tr.docs[i]!, step));
}

const amIndex = (doc: PMNode, pos: number) => pos - doc.resolve(pos).index(0);

/**
 * | Step                                  | Made by                                        | TextEdits                     |
 * | ------------------------------------- | ---------------------------------------------- | ----------------------------- |
 * | ReplaceStep                           | typing, delete, Enter, join, paste, undo       | `replaceEdits`                |
 * | ReplaceAroundStep retyping one block  | setBlockType, setNodeMarkup                    | setBlock                      |
 * | AttrStep                              | setNodeAttribute: depth, checked               | setBlock                      |
 * | AddMarkStep, RemoveMarkStep           | toggleMark, addMark, removeMark                | mark                          |
 * | MarkSetStep (not exported by PM)      | undo or redo of a mark change                  | each of its mark steps        |
 * | anything else                         | nothing in this schema                         | throws UnsupportedStep        |
 */
function stepEdits(doc: PMNode, step: Step): TextEdit[] {
  if (step instanceof ReplaceStep) return replaceEdits(doc, step.from, step.to, step.slice);
  if (step instanceof ReplaceAroundStep && retypesOneBlock(doc, step)) {
    return [{ type: "setBlock", at: amIndex(doc, step.from), block: blockOf(step.slice.content.firstChild!) }];
  }
  if (step instanceof AttrStep) {
    const node = doc.nodeAt(step.pos)!;
    return [{ type: "setBlock", at: amIndex(doc, step.pos), block: blockOf(node.type.create({ ...node.attrs, [step.attr]: step.value })) }];
  }
  if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
    const name = step.mark.type.name as MarkName;
    const value = step instanceof RemoveMarkStep ? null : name === "link" ? (step.mark.attrs.href as string) : true;
    return [markEdit(name, amIndex(doc, step.from), amIndex(doc, step.to), value)];
  }
  // Mark steps never move positions, so each one maps against the same doc.
  const parts = (step as { steps?: unknown }).steps;
  if (Array.isArray(parts) && parts.every((s) => s instanceof AddMarkStep || s instanceof RemoveMarkStep)) {
    return parts.flatMap((s: Step) => stepEdits(doc, s));
  }
  throw new UnsupportedStep(step);
}

function markEdit(name: MarkName, start: number, end: number, value: string | true | null): MarkEdit {
  return { type: "mark", start, end, name, value } as MarkEdit;
}

/** setBlockType's shape: the whole top-level block, wrapped again in one empty node of the new type. */
function retypesOneBlock(doc: PMNode, step: ReplaceAroundStep): boolean {
  const { from, to, gapFrom, gapTo, insert, slice } = step;
  return (
    insert === 1 &&
    slice.openStart === 0 &&
    slice.openEnd === 0 &&
    slice.content.childCount === 1 &&
    slice.content.firstChild!.content.size === 0 &&
    gapFrom === from + 1 &&
    gapTo === to - 1 &&
    doc.resolve(from).depth === 0 &&
    doc.nodeAt(from)?.nodeSize === to - from
  );
}

type Token = { readonly block: Block } | { readonly text: string; readonly marks: Marks };

/**
 * A ReplaceStep is a delete of [a, b), then a stream of tokens typed at a. An
 * inline slice gives one text token per text node. A block slice gives, per
 * block, a marker token and then its text, except that the first block of an
 * open start has no marker: its text joins the block at a. An open end needs
 * nothing, because the text after b stays in the last token's block, which is
 * PM's rule too.
 *
 * Index 0 is the first marker and no edit may remove it, so a step at a = 0
 * retypes marker 0 instead of deleting and re-adding it.
 */
function replaceEdits(doc: PMNode, from: number, to: number, slice: Slice): TextEdit[] {
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  let a = from - $from.index(0);
  let b = to - $to.index(0);
  const tokens: Token[] = [];
  const text = (fragment: Fragment) =>
    fragment.forEach((node) => {
      if (node.text) tokens.push({ text: node.text, marks: marksOf(node.marks) });
    });
  if ($from.depth - slice.openStart === 1) text(slice.content);
  else
    slice.content.forEach((block, _offset, i) => {
      if (!(i === 0 && slice.openStart === 1)) tokens.push({ block: blockOf(block) });
      text(block.content);
    });

  const edits: TextEdit[] = [];
  let tail: Block | null = null;
  if (a === 0) {
    const first = tokens[0];
    if (first && "block" in first) {
      edits.push({ type: "setBlock", at: 0, block: first.block });
      tokens.shift();
      // Nothing was deleted, so the old first block still follows and needs its marker back.
      if (b === 0) tail = blockOf(doc.child(0));
      else b = Math.max(b, 1);
    } else {
      // Whole leading blocks were deleted: marker 0 takes the type of the block that survives at `to`.
      edits.push({ type: "setBlock", at: 0, block: blockOf(doc.child($to.index(0))) });
      b += 1;
    }
    a = 1;
  }
  if (b > a) edits.push({ type: "delete", at: a, count: b - a });
  let at = a;
  for (const token of tokens) {
    if ("block" in token) edits.push({ type: "split", at: at++, block: token.block });
    else {
      edits.push({ type: "insert", at, text: token.text, marks: token.marks });
      at += token.text.length;
    }
  }
  if (tail) edits.push({ type: "split", at, block: tail });
  return edits;
}

/** Automerge gap x (x >= 1, after character x-1) to the PM position inside the block that holds x-1. */
function pmGap(doc: PMNode, x: number): number {
  let am = 0;
  let pm = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const node = doc.child(i);
    const end = am + 1 + node.content.size;
    if (x <= end) return pm + x - am;
    am = end;
    pm += node.nodeSize;
  }
  throw new RangeError(`gap ${x} is past the end (${am})`);
}

/** Automerge marker index to the PM position of the boundary before its block. */
function pmMarker(doc: PMNode, x: number): number {
  let am = 0;
  let pm = 0;
  for (let i = 0; i < doc.childCount; i++) {
    if (am === x) return pm;
    const node = doc.child(i);
    am += 1 + node.content.size;
    pm += node.nodeSize;
  }
  throw new RangeError(`no block marker at ${x}`);
}

/**
 * A peer's edits as one transaction, kept out of undo history. Each edit maps
 * against the doc the edits before it left. Remote edits must be applied in
 * the task they arrive in: a later local translation would read stale indexes.
 */
export function remoteTransaction(state: EditorState, edits: readonly TextEdit[]): Transaction {
  const tr = state.tr.setMeta("addToHistory", false).setMeta(REMOTE, true);
  for (const edit of edits) {
    const doc = tr.doc;
    switch (edit.type) {
      case "insert":
        tr.insert(pmGap(doc, edit.at), schema.text(edit.text, pmMarks(edit.marks)));
        break;
      case "delete":
        tr.delete(pmGap(doc, edit.at), pmGap(doc, edit.at + edit.count));
        break;
      case "split": {
        const { type, attrs } = nodeTypeOf(edit.block);
        // A marker at 0 is a peer retyping block 0: the model writes a new marker at 0, then deletes the old one at 1.
        if (edit.at === 0) tr.insert(0, type.create(attrs));
        else tr.split(pmGap(doc, edit.at), 1, [{ type, attrs }]);
        break;
      }
      case "setBlock": {
        const { type, attrs } = nodeTypeOf(edit.block);
        tr.setNodeMarkup(pmMarker(doc, edit.at), type, attrs);
        break;
      }
      case "mark": {
        const from = pmGap(doc, Math.max(1, edit.start));
        const to = pmGap(doc, Math.max(1, edit.end));
        if (from >= to) break;
        if (edit.value === null) tr.removeMark(from, to, schema.marks[edit.name]!);
        else tr.addMark(from, to, markOf(edit.name, edit.value));
        break;
      }
    }
  }
  return tr;
}
