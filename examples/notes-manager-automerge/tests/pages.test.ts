import * as A from "@automerge/automerge";
import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteSelection } from "prosemirror-commands";
import { undo } from "prosemirror-history";
import { NodeSelection, TextSelection, type Command } from "prosemirror-state";
import { caretAtTop, fixPages, guardPages, insertPageBlock, openSelectedPage, removedPages, selectPageAfter, selectPageBefore } from "../src/editor/pages.ts";
import { schema } from "../src/editor/schema.ts";
import { newPageId } from "../src/model/bodies.ts";
import { toSpans, type BodyDoc } from "../src/model/text-edits.ts";
import type { PageId } from "../src/model/types.ts";
import { P, block, menuPage, page, pageOf, text } from "./editor.ts";

test("a page block round-trips through the body, and a marker with a bad id reads as a paragraph", async () => {
  const id = newPageId();
  const p = await page([P, text("a"), pageOf(id), P]);
  assert.deepEqual(p.spans, [P, text("a"), pageOf(id), P]);

  let doc = A.from<BodyDoc>({ text: "" });
  doc = A.change(doc, (d) => {
    A.splitBlock(d, ["text"], 0, { type: "page", parents: [], attrs: { id: "not an id" } });
  });
  assert.deepEqual(toSpans(doc), [P]);
});

test("/page in an empty line turns it into a page block, opens the page, and leaves a line after it", async () => {
  const id = newPageId();
  const p = await menuPage([P, text("intro"), P], () => id);
  p.at(8);
  p.type("/pa");
  assert.deepEqual(
    p.menu()?.items.map((item) => item.label),
    ["Page", "Text"],
    "Text matches by its word 'paragraph'",
  );
  p.type("g");
  assert.ok(p.key("Enter"));
  assert.deepEqual(p.spans, [P, text("intro"), pageOf(id), P]);
  assert.deepEqual(p.opened, [id]);
  assert.equal(p.menu(), null);
  assert.ok(p.state.selection instanceof NodeSelection, "the new block is selected");
});

test("/page after text puts the page block after that block, and the text loses only the command", async () => {
  const id = newPageId();
  const p = await menuPage([P, text("Hello "), P, text("next")], () => id);
  p.at(7);
  p.type("/page");
  p.key("Enter");
  assert.deepEqual(p.spans, [P, text("Hello "), pageOf(id), P, text("next")]);
});

test("the / menu retypes a block, keeps a list's depth, and closes on Escape, on no match, and mid-word", async () => {
  const p = await menuPage([block({ type: "item", list: "bullet", depth: 2 }), text("x ")]);
  p.at(3);
  p.type("/num");
  p.key("Enter");
  assert.deepEqual(p.spans, [block({ type: "item", list: "number", depth: 2 }), text("x ")]);

  p.type("/h");
  assert.deepEqual(
    p.menu()?.items.map((item) => item.label),
    ["Heading 1", "Heading 2", "Heading 3"],
  );
  p.key("ArrowDown");
  p.key("Enter");
  assert.deepEqual(p.spans, [block({ type: "heading", level: 2 }), text("x ")], "the second match");

  p.type("/");
  assert.ok(p.menu());
  p.key("Escape");
  assert.equal(p.menu(), null);
  assert.deepEqual(p.spans, [block({ type: "heading", level: 2 }), text("x /")], "Escape keeps the typed /");

  p.type(" /zz");
  assert.equal(p.menu(), null, "nothing matches");
  p.type(" a/");
  assert.equal(p.menu(), null, "a / inside a word is text");
  assert.equal(p.key("Enter"), false, "no menu, so Enter is the editor's");
});

test("removedPages names a child whose last block a change removes, and nothing for a move or a non-child", async () => {
  const [a, b] = [newPageId(), newPageId()];
  const p = await page([P, text("x"), pageOf(a), pageOf(b), P]);
  const { doc } = p.state;
  const aPos = 3;
  const bPos = 5;
  const child = (id: PageId) => id === a;
  assert.deepEqual(removedPages(p.state.tr.delete(aPos, aPos + 2), child), [a]);
  assert.deepEqual(removedPages(p.state.tr.delete(bPos, bPos + 2), child), [], "b is not a child");
  const move = p.state.tr.delete(aPos, aPos + 2);
  move.insert(move.doc.content.size, schema.nodes.page!.create({ id: a }));
  assert.deepEqual(removedPages(move, child), [], "a move keeps the page");
  assert.deepEqual(removedPages(p.state.tr.insertText("y", 2), child), [], "typing touches no page");
  assert.deepEqual(removedPages(p.state.tr.setNodeMarkup(aPos, schema.nodes.paragraph!), child), [a], "retyping the block removes it");
  assert.equal(doc, p.state.doc);
});

type Ask = { readonly ids: readonly PageId[]; readonly pos: number; readonly confirm: Command };

test("the page guard holds back removing a child's block, and its confirm applies the whole change", async () => {
  const child = newPageId();
  const asked: Ask[] = [];
  const guard = guardPages((id) => id === child, (ids, pos, confirm) => void asked.push({ ids, pos, confirm }));
  const spans = [P, text("keep"), P, text("cut me"), pageOf(child), P, text("and me")];
  const p = await page(spans, [guard]);
  p.view.dispatch(p.state.tr.setSelection(TextSelection.create(p.state.doc, 7, p.state.doc.content.size - 1)));
  p.run(deleteSelection);
  assert.deepEqual(p.spans, spans, "held back");
  assert.deepEqual(asked.map(({ ids, pos }) => ({ ids, pos })), [{ ids: [child], pos: 14 }]);
  assert.ok(p.run(asked[0]!.confirm));
  assert.deepEqual(p.spans, [P, text("keep"), P], "the text went with the page block");
});

test("the page guard's confirm refuses once the body changed, and lets other changes through", async () => {
  const child = newPageId();
  const other = newPageId();
  const asked: Ask[] = [];
  const p = await page([P, text("a"), pageOf(child), P, text("b"), pageOf(other), P], [guardPages((id) => id === child, (ids, pos, confirm) => void asked.push({ ids, pos, confirm }))]);
  p.view.dispatch(p.state.tr.setSelection(NodeSelection.create(p.state.doc, 3)));
  p.run(deleteSelection);
  assert.equal(asked.length, 1);
  p.view.dispatch(p.state.tr.insertText("!", 2));
  assert.equal(p.run(asked[0]!.confirm), false, "the held change no longer fits");
  assert.deepEqual(p.spans, [P, text("a!"), pageOf(child), P, text("b"), pageOf(other), P]);

  p.view.dispatch(p.state.tr.setSelection(NodeSelection.create(p.state.doc, 9)));
  p.run(deleteSelection);
  assert.deepEqual(p.spans, [P, text("a!"), pageOf(child), P, text("b"), P], "a page that is not a child goes without asking");
  p.remote([{ type: "delete", at: 3, count: 1 }]);
  assert.deepEqual(p.spans, [P, text("a!"), P, text("b"), P], "another tab's change is not held");
  assert.equal(asked.length, 1);
});

test("on open the body drops stale and second blocks, adds missing children at the end, and ends with a line", async () => {
  const [a, b, c, gone] = [newPageId(), newPageId(), newPageId(), newPageId()];
  const p = await page([P, text("x"), pageOf(a), pageOf(gone), pageOf(b), pageOf(a)]);
  p.apply((s) => fixPages(s, { children: [a, b, c], open: true }));
  assert.deepEqual(p.spans, [P, text("x"), pageOf(a), pageOf(b), pageOf(c), P]);
  p.apply((s) => fixPages(s, { children: [a, b, c], open: true }));
  assert.deepEqual(p.spans, [P, text("x"), pageOf(a), pageOf(b), pageOf(c), P], "a second open changes nothing");
  assert.equal(fixPages(p.state, { children: [a, b, c], open: true }), null);

  p.apply((s) => fixPages(s, { children: [a, c], gone: new Set([b]) }));
  assert.deepEqual(p.spans, [P, text("x"), pageOf(a), pageOf(c), P], "a child that left the tree loses its block");
  p.run(undo);
  assert.deepEqual(p.spans, [P, text("x"), pageOf(a), pageOf(c), P], "repairs are not undone");
});

test("text a merge leaves after a page marker becomes a paragraph after the block", async () => {
  const a = newPageId();
  const p = await page([P, pageOf(a), text("typed")]);
  p.apply((s) => fixPages(s, { children: [a] }));
  assert.deepEqual(p.spans, [P, pageOf(a), P, text("typed")]);
});

test("Backspace and Delete next to a page block select it, Enter opens it, and the title's Enter adds a line above it", async () => {
  const a = newPageId();
  const p = await page([P, text("x"), pageOf(a), P, text("y"), P]);
  p.at(6);
  assert.ok(p.run(selectPageBefore));
  assert.ok(p.state.selection instanceof NodeSelection && p.state.selection.from === 3, "the page is selected");
  assert.deepEqual(p.spans, [P, text("x"), pageOf(a), P, text("y"), P], "and kept");

  p.at(2);
  assert.ok(p.run(selectPageAfter));
  assert.ok(p.state.selection instanceof NodeSelection && p.state.selection.from === 3);

  const opened: PageId[] = [];
  assert.ok(p.run(openSelectedPage((id) => opened.push(id))));
  assert.deepEqual(opened, [a]);

  const q = await page([pageOf(a), P, P]);
  q.at(3);
  assert.ok(q.run(selectPageBefore));
  assert.deepEqual(q.spans, [pageOf(a), P], "an empty line before the last one goes");
  q.at(3);
  q.run(selectPageBefore);
  assert.deepEqual(q.spans, [pageOf(a), P], "the last line stays");
  q.run(caretAtTop);
  assert.deepEqual(q.spans, [P, pageOf(a), P]);
  assert.equal(q.state.selection.from, 1);
});

test("insertPageBlock in the last block leaves a paragraph after the page", async () => {
  const a = newPageId();
  const p = await page([P, text("end")]);
  p.apply((s) => insertPageBlock(s.tr, 2, a));
  assert.deepEqual(p.spans, [P, text("end"), pageOf(a), P]);
});
