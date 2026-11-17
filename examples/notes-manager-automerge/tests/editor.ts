import assert from "node:assert/strict";
import { test } from "node:test";
import { history } from "prosemirror-history";
import { TextSelection, type Command, type EditorState, type Plugin, type Transaction } from "prosemirror-state";
import { applyLocal, bodyState, remoteTransaction } from "../src/editor/binding.ts";
import { menuKey, menuPlugin } from "../src/editor/menu.ts";
import { docToSpans } from "../src/editor/schema.ts";
import { newPageId } from "../src/model/bodies.ts";
import { openNotes } from "../src/model/notes.ts";
import type { Block, PageBody, PageId, Span, TextEdit } from "../src/model/types.ts";
import { memoryStorage } from "../src/storage/memory.ts";

const notes = await openNotes({ storage: memoryStorage() });
test.after(() => notes.close());

export const block = (b: Block): Span => ({ type: "block", block: b });
export const text = (t: string): Span => ({ type: "text", text: t, marks: {} });
export const P = block({ type: "paragraph" });
export const pageOf = (id: PageId) => block({ type: "page", id });

/** A body holding `spans`, and an editor state on it whose every dispatch must keep the model equal to PM. */
export async function page(spans: readonly Span[], plugins: readonly Plugin[] = []) {
  const body: PageBody = await notes.bodies.open(newPageId());
  const edits: TextEdit[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.type === "text") {
      edits.push({ type: "insert", at, text: span.text, marks: span.marks });
      at += span.text.length;
    } else {
      edits.push(at === 0 ? { type: "setBlock", at, block: span.block } : { type: "split", at, block: span.block });
      at += 1;
    }
  }
  body.edit(edits);
  let state = bodyState(body, [...plugins, history()]);
  const view = {
    composing: false,
    get state() {
      return state;
    },
    dispatch(tr: Transaction) {
      state = applyLocal(body, state, tr);
      assert.deepEqual(body.spans(), docToSpans(state.doc), "the model equals PM");
    },
  };
  return {
    view,
    get state() {
      return state;
    },
    get spans() {
      return docToSpans(state.doc);
    },
    /** A change another tab made: the body holds it, and PM replays it. */
    remote(edits: readonly TextEdit[]) {
      body.edit(edits);
      view.dispatch(remoteTransaction(state, edits));
    },
    at(pos: number) {
      view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos)));
    },
    run(command: Command): boolean {
      return command(state, (tr) => view.dispatch(tr));
    },
    apply(build: (s: EditorState) => Transaction | null) {
      const tr = build(state);
      if (tr) view.dispatch(tr);
    },
  };
}

export async function menuPage(spans: readonly Span[], onCreate: () => PageId = newPageId, more: readonly Plugin[] = []) {
  const opened: PageId[] = [];
  const plugin = menuPlugin({ createPage: onCreate, openPage: (id) => void opened.push(id), show: () => {} });
  const p = await page(spans, [plugin, ...more]);
  const props = plugin.props as unknown as {
    handleTextInput(view: unknown, from: number, to: number, text: string): boolean;
    handleKeyDown(view: unknown, event: Partial<KeyboardEvent>): boolean;
    handleDOMEvents: { blur(view: unknown): boolean };
  };
  return Object.assign(p, {
    opened,
    menu: () => menuKey.getState(p.state),
    type(chars: string) {
      for (const char of chars) {
        const { from, to } = p.state.selection;
        if (!props.handleTextInput(p.view, from, to, char)) p.view.dispatch(p.state.tr.insertText(char, from, to));
      }
    },
    key: (key: string) => props.handleKeyDown(p.view, { key, isComposing: false }),
    blur: () => props.handleDOMEvents.blur(p.view),
  });
}
