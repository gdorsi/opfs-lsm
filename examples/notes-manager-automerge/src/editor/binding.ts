import type { Fragment, Node as PMNode, Slice } from "prosemirror-model";
import { EditorState, NodeSelection, type Plugin, type Transaction } from "prosemirror-state";
import { AddMarkStep, AttrStep, RemoveMarkStep, ReplaceAroundStep, ReplaceStep, type Step } from "prosemirror-transform";
import type { Block, MarkEdit, MarkName, Marks, PageBody, TextEdit } from "../model/types.ts";
import { blockOf, markOf, marksOf, nodeTypeOf, pmMarks, schema, spansToDoc } from "./schema.ts";

const REMOTE = "pages:remote";

export class UnsupportedStep extends Error {
  constructor(step: Step) {
    super(`the editor cannot store a ${step.constructor.name}`);
    this.name = "UnsupportedStep";
  }
}

export function bodyState(body: Pick<PageBody, "spans">, plugins: readonly Plugin[] = []): EditorState {
  return EditorState.create({ doc: spansToDoc(body.spans()), plugins: [...plugins] });
}

export function applyLocal(body: Pick<PageBody, "edit">, state: EditorState, tr: Transaction): EditorState {
  const { state: next, transactions } = state.applyTransaction(tr);
  body.edit(transactions.filter((t) => t.docChanged && !t.getMeta(REMOTE)).flatMap(localEdits));
  return next;
}

/** A transaction that replays a remote change, which the body already holds. */
export const isRemote = (tr: Transaction): boolean => tr.getMeta(REMOTE) === true;

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

function replaceEdits(doc: PMNode, from: number, to: number, slice: Slice): TextEdit[] {
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  let start = from - $from.index(0);
  let end = to - $to.index(0);
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
  const atFirstMarker = start === 0;
  if (atFirstMarker) {
    const first = tokens[0];
    if (first && "block" in first) {
      edits.push({ type: "setBlock", at: 0, block: first.block });
      tokens.shift();
      if (end === 0) tail = blockOf(doc.child(0));
      else end = Math.max(end, 1);
    } else {
      edits.push({ type: "setBlock", at: 0, block: blockOf(doc.child($to.index(0))) });
      end += 1;
    }
    start = 1;
  }
  if (end > start) edits.push({ type: "delete", at: start, count: end - start });
  let at = start;
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

function posOfGap(doc: PMNode, index: number): number {
  let am = 0;
  let pm = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const node = doc.child(i);
    const end = am + 1 + node.content.size;
    if (index <= end) return pm + index - am;
    am = end;
    pm += node.nodeSize;
  }
  throw new RangeError(`gap ${index} is past the end (${am})`);
}

function posOfMarker(doc: PMNode, index: number): number {
  let am = 0;
  let pm = 0;
  for (let i = 0; i < doc.childCount; i++) {
    if (am === index) return pm;
    const node = doc.child(i);
    am += 1 + node.content.size;
    pm += node.nodeSize;
  }
  throw new RangeError(`no block marker at ${index}`);
}

export function remoteTransaction(state: EditorState, edits: readonly TextEdit[]): Transaction {
  const tr = state.tr.setMeta("addToHistory", false).setMeta(REMOTE, true);
  for (const edit of edits) {
    const doc = tr.doc;
    switch (edit.type) {
      case "insert":
        tr.insert(posOfGap(doc, edit.at), schema.text(edit.text, pmMarks(edit.marks)));
        break;
      case "delete":
        tr.delete(posOfGap(doc, edit.at), posOfGap(doc, edit.at + edit.count));
        break;
      case "split": {
        const { type, attrs } = nodeTypeOf(edit.block);
        if (edit.at === 0) tr.insert(0, type.create(attrs));
        else tr.split(posOfGap(doc, edit.at), 1, [{ type, attrs }]);
        break;
      }
      case "setBlock": {
        const { type, attrs } = nodeTypeOf(edit.block);
        tr.setNodeMarkup(posOfMarker(doc, edit.at), type, attrs);
        break;
      }
      case "mark": {
        const from = posOfGap(doc, Math.max(1, edit.start));
        const to = posOfGap(doc, Math.max(1, edit.end));
        if (from >= to) break;
        if (edit.value === null) tr.removeMark(from, to, schema.marks[edit.name]!);
        else tr.addMark(from, to, markOf(edit.name, edit.value));
        break;
      }
    }
  }
  // A retype maps a block selection to a caret, as a replacement does. The block keeps the selection while its text
  // still starts a block: a merge into the block above, or a delete, lets it go.
  const { selection } = state;
  if (selection instanceof NodeSelection && !(tr.selection instanceof NodeSelection)) {
    const inside = tr.mapping.mapResult(selection.from + 1);
    const $inside = tr.doc.resolve(inside.pos);
    if (!inside.deleted && $inside.depth === 1 && $inside.parentOffset === 0) tr.setSelection(NodeSelection.create(tr.doc, $inside.before(1)));
  }
  return tr;
}
