import assert from "node:assert/strict";
import { test } from "node:test";
import { history } from "prosemirror-history";
import { undoInputRule } from "prosemirror-inputrules";
import { TextSelection, type Command } from "prosemirror-state";
import { applyLocal, bodyState } from "../src/editor/binding.ts";
import { backspaceToParagraph, enter, indent, setLink, toggleLink, toggleTodo } from "../src/editor/commands.ts";
import { pageInputRules } from "../src/editor/rules.ts";
import { docToSpans } from "../src/editor/schema.ts";
import { newPageId } from "../src/model/bodies.ts";
import { openNotes } from "../src/model/notes.ts";
import type { Block, PageBody, Span, TextEdit } from "../src/model/types.ts";
import { memoryStorage } from "../src/storage/memory.ts";

const notes = await openNotes({ storage: memoryStorage() });
test.after(() => notes.close());

async function page(spans: readonly Span[]) {
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
  const rules = pageInputRules();
  let state = bodyState(body, [rules, history()]);
  const view = {
    composing: false,
    get state() {
      return state;
    },
    dispatch(tr: Parameters<typeof applyLocal>[2]) {
      state = applyLocal(body, state, tr);
      assert.deepEqual(body.spans(), docToSpans(state.doc), "the model equals PM");
    },
  };
  const handleTextInput = rules.props.handleTextInput as unknown as (v: typeof view, from: number, to: number, text: string) => boolean;
  return {
    get state() {
      return state;
    },
    get spans() {
      return docToSpans(state.doc);
    },
    at(pos: number, to = pos) {
      view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos, to)));
    },
    type(text: string) {
      for (const char of text) {
        const { from, to } = state.selection;
        if (!handleTextInput(view, from, to, char)) view.dispatch(state.tr.insertText(char, from, to));
      }
    },
    run(command: Command): boolean {
      return command(state, (tr) => view.dispatch(tr));
    },
  };
}

const block = (b: Block): Span => ({ type: "block", block: b });
const text = (t: string): Span => ({ type: "text", text: t, marks: {} });
const P = block({ type: "paragraph" });
const blocks = (spans: readonly Span[]) => spans.filter((s) => s.type === "block").map((s) => s.block);

test("each markdown rule at the start of a block retypes it and drops the typed prefix", async () => {
  const cases: [string, Block][] = [
    ["# ", { type: "heading", level: 1 }],
    ["## ", { type: "heading", level: 2 }],
    ["### ", { type: "heading", level: 3 }],
    ["- ", { type: "item", list: "bullet", depth: 0 }],
    ["* ", { type: "item", list: "bullet", depth: 0 }],
    ["1. ", { type: "item", list: "number", depth: 0 }],
    ["[] ", { type: "todo", depth: 0, checked: false }],
    ["[ ] ", { type: "todo", depth: 0, checked: false }],
  ];
  for (const [prefix, expected] of cases) {
    const p = await page([P]);
    p.at(1);
    p.type(prefix + "x");
    assert.deepEqual(p.spans, [block(expected), text("x")], `"${prefix}" makes ${JSON.stringify(expected)}`);
  }
});

test("a list rule keeps the block's depth, and a rule that changes nothing types its text", async () => {
  const p = await page([block({ type: "item", list: "bullet", depth: 2 })]);
  p.at(1);
  p.type("1. ");
  assert.deepEqual(p.spans, [block({ type: "item", list: "number", depth: 2 })], "number item at depth 2");
  p.type("[] ");
  assert.deepEqual(p.spans, [block({ type: "todo", depth: 2, checked: false })], "todo at depth 2");
  p.type("[] ");
  assert.deepEqual(p.spans, [block({ type: "todo", depth: 2, checked: false }), text("[] ")], "same block: the text stays");
});

test("a rule fires only at the start of a block, and Backspace right after it undoes it", async () => {
  const p = await page([P]);
  p.at(1);
  p.type("a# ");
  assert.deepEqual(p.spans, [P, text("a# ")], "mid-text '# ' is text");

  const q = await page([P]);
  q.at(1);
  q.type("## ");
  assert.deepEqual(blocks(q.spans), [{ type: "heading", level: 2 }]);
  assert.ok(q.run(undoInputRule), "Backspace runs undoInputRule first");
  assert.deepEqual(q.spans, [P, text("## ")], "the paragraph and its typed text come back");
});

test("Tab and Shift-Tab change depth on every item and todo in the selection, within 0..5", async () => {
  const p = await page([block({ type: "item", list: "bullet", depth: 4 }), text("a"), P, text("b"), block({ type: "todo", depth: 0, checked: true }), text("c")]);
  p.at(1, p.state.doc.content.size - 1);
  assert.ok(p.run(indent(1)));
  assert.deepEqual(blocks(p.spans), [{ type: "item", list: "bullet", depth: 5 }, { type: "paragraph" }, { type: "todo", depth: 1, checked: true }]);
  assert.ok(p.run(indent(1)), "Tab is handled at depth 5, so focus stays in the editor");
  assert.deepEqual(blocks(p.spans)[0], { type: "item", list: "bullet", depth: 5 }, "depth stops at 5");
  for (let i = 0; i < 7; i++) p.run(indent(-1));
  assert.deepEqual(blocks(p.spans), [{ type: "item", list: "bullet", depth: 0 }, { type: "paragraph" }, { type: "todo", depth: 0, checked: true }], "depth stops at 0");
  const q = await page([P, text("x")]);
  q.at(2);
  assert.ok(q.run(indent(1)), "Tab in a paragraph is handled and changes nothing");
  assert.deepEqual(q.spans, [P, text("x")]);
});

test("Enter continues a list, leaves it from an empty item, and ends a heading with a paragraph", async () => {
  const p = await page([block({ type: "item", list: "number", depth: 1 }), text("one")]);
  p.at(4);
  p.run(enter);
  assert.deepEqual(blocks(p.spans), [{ type: "item", list: "number", depth: 1 }, { type: "item", list: "number", depth: 1 }], "the new item continues the list");
  p.run(enter);
  assert.deepEqual(blocks(p.spans)[1], { type: "item", list: "number", depth: 0 }, "an empty item moves out a level");
  p.run(enter);
  assert.deepEqual(blocks(p.spans)[1], { type: "paragraph" }, "at depth 0 it leaves the list");

  const t = await page([block({ type: "todo", depth: 2, checked: true }), text("done")]);
  t.at(5);
  t.run(enter);
  assert.deepEqual(blocks(t.spans)[1], { type: "todo", depth: 2, checked: false }, "a todo continues unchecked");

  const h = await page([block({ type: "heading", level: 1 }), text("Title")]);
  h.at(6);
  h.run(enter);
  assert.deepEqual(blocks(h.spans), [{ type: "heading", level: 1 }, { type: "paragraph" }], "Enter at a heading's end gives a paragraph");
});

test("Backspace at the start of a heading, item or todo makes it a paragraph and keeps the text", async () => {
  for (const b of [{ type: "heading", level: 2 }, { type: "item", list: "bullet", depth: 3 }, { type: "todo", depth: 0, checked: false }] as Block[]) {
    const p = await page([P, text("a"), block(b), text("keep")]);
    p.at(4);
    assert.ok(p.run(backspaceToParagraph), `handled at the start of ${b.type}`);
    assert.deepEqual(p.spans, [P, text("a"), P, text("keep")]);
  }
  const p = await page([block({ type: "heading", level: 1 }), text("ab")]);
  p.at(2);
  assert.equal(p.run(backspaceToParagraph), false, "mid-text, Backspace falls through to deleting a character");
  const q = await page([P, text("a"), P, text("b")]);
  q.at(4);
  assert.equal(q.run(backspaceToParagraph), false, "at a paragraph's start, Backspace falls through to joining");
});

test("Mod-Enter and the checkbox toggle a todo", async () => {
  const p = await page([P, text("a"), block({ type: "todo", depth: 0, checked: false }), text("task")]);
  p.at(5);
  assert.ok(p.run(toggleTodo()));
  assert.deepEqual(blocks(p.spans)[1], { type: "todo", depth: 0, checked: true });
  assert.ok(p.run(toggleTodo(3)), "the checkbox names its block's position");
  assert.deepEqual(blocks(p.spans)[1], { type: "todo", depth: 0, checked: false });
  p.at(1);
  assert.equal(p.run(toggleTodo()), false, "Mod-Enter outside a todo does nothing");
});

test("Mod-k asks for a URL on unlinked text, the answer links the selection, and Mod-k on a link removes it", async () => {
  const p = await page([P, text("hello")]);
  let asked = 0;
  const ask = () => void asked++;
  p.at(1);
  assert.equal(p.run(toggleLink(ask)), false, "nothing to link without a selection");
  p.at(1, 6);
  assert.ok(p.run(toggleLink(ask)), "Mod-k is handled");
  assert.equal(asked, 1, "the page is asked for a URL");
  assert.deepEqual(p.spans, [P, text("hello")], "asking changes nothing");
  assert.equal(p.run(setLink("  ")), false, "a blank answer changes nothing");
  p.run(setLink(" x.example "));
  assert.deepEqual(p.spans, [P, { type: "text", text: "hello", marks: { link: "https://x.example" } }], "a bare host reads as https");
  p.run(setLink("mailto:a@x.example"));
  assert.deepEqual(p.spans, [P, { type: "text", text: "hello", marks: { link: "mailto:a@x.example" } }], "a scheme is kept");
  p.run(setLink("https://x.example"));
  p.at(2, 3);
  p.run(toggleLink(() => assert.fail("no question when removing")));
  assert.deepEqual(p.spans, [P, { type: "text", text: "h", marks: { link: "https://x.example" } }, text("e"), { type: "text", text: "llo", marks: { link: "https://x.example" } }]);
});
