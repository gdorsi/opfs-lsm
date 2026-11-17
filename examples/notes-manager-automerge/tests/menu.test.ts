import assert from "node:assert/strict";
import { test } from "node:test";
import { NodeSelection, Plugin, TextSelection } from "prosemirror-state";
import { addBlock, menuKey, runMenu, toggleBlockMenu } from "../src/editor/menu.ts";
import { removedPages } from "../src/editor/pages.ts";
import { newPageId } from "../src/model/bodies.ts";
import type { Block, Depth, PageId } from "../src/model/types.ts";
import { P, block, menuPage, pageOf, text } from "./editor.ts";

const currentOf = (menu: ReturnType<typeof menuKey.getState>) => (menu && "current" in menu ? menu.current : -1);
const labels = (menu: { items: readonly { label: string }[] } | null | undefined) => menu?.items.map((item) => item.label);
const H1: Block = { type: "heading", level: 1 };
const todoBlock = (checked: boolean, depth: Depth = 0): Block => ({ type: "todo", depth, checked });
const todo = (checked: boolean, depth: Depth = 0) => block(todoBlock(checked, depth));

test("the block menu opens on the caret's block, selects it, and Mod-/ or Escape puts the caret back", async () => {
  const p = await menuPage([P, text("one"), P, text("two")]);
  p.at(7);
  assert.ok(p.run(toggleBlockMenu()));
  assert.ok(p.state.selection instanceof NodeSelection, "the block is selected");
  assert.equal(p.state.selection.from, 5);
  assert.equal(p.menu()?.kind, "block");
  assert.equal(p.menu()?.index, 0, "it starts on the block's current kind");

  assert.ok(p.run(toggleBlockMenu()), "Mod-/ again");
  assert.equal(p.menu(), null);
  assert.ok(p.state.selection instanceof TextSelection, "the caret is back");
  assert.equal(p.state.selection.from, 7);

  p.run(toggleBlockMenu());
  p.key("Escape");
  assert.equal(p.menu(), null);
  assert.equal(p.state.selection.from, 7);
  assert.deepEqual(p.spans, [P, text("one"), P, text("two")], "nothing changed");
});

test("opened from the handle the caret lands at the end of that block, and a range stays a range", async () => {
  const p = await menuPage([P, text("one"), P, text("two")]);
  p.at(7);
  p.run(toggleBlockMenu(0));
  assert.ok(p.state.selection instanceof NodeSelection);
  assert.equal(p.state.selection.from, 0);
  p.key("Escape");
  assert.ok(p.state.selection instanceof TextSelection);
  assert.equal(p.state.selection.from, 4, "end of the first block's text");

  p.view.dispatch(p.state.tr.setSelection(TextSelection.create(p.state.doc, 6, 8)));
  p.run(toggleBlockMenu());
  p.key("Escape");
  assert.deepEqual([p.state.selection.from, p.state.selection.to], [6, 8], "a range inside the block comes back whole");
});

test("a block menu does not open over the / menu, and the / menu replaces nothing of it", async () => {
  const p = await menuPage([P, text("a ")]);
  p.at(3);
  p.type("/");
  assert.equal(p.run(toggleBlockMenu()), false);
  assert.equal(p.menu()?.kind, "slash");
  assert.equal(p.run(toggleBlockMenu(99)), false, "no block there");
});

test("turn keeps a checked to-do checked and a list's depth, and turns anything else", async () => {
  const p = await menuPage([todo(true, 1), text("done"), P, text("x")]);
  p.at(3);
  p.run(toggleBlockMenu());
  assert.equal(currentOf(p.menu()), labels(p.menu())?.indexOf("To-do list"));
  p.key("Enter");
  assert.deepEqual(p.spans, [todo(true, 1), text("done"), P, text("x")], "a turn into the same kind is a no-op");

  p.at(3);
  p.run(toggleBlockMenu());
  p.type("numbered");
  p.key("Enter");
  assert.deepEqual(p.spans, [block({ type: "item", list: "number", depth: 1 }), text("done"), P, text("x")], "depth stays");

  p.at(3);
  p.run(toggleBlockMenu());
  p.type("h2");
  p.key("Enter");
  assert.deepEqual(p.spans[0], block({ type: "heading", level: 2 }));
  assert.ok(p.state.selection instanceof TextSelection, "the caret returns");
});

test("duplicate puts a copy below, and delete removes the block and leaves a caret", async () => {
  const p = await menuPage([P, text("a"), todo(true), text("b"), P, text("c")]);
  p.at(5);
  p.run(toggleBlockMenu());
  p.type("dup");
  p.key("Enter");
  assert.deepEqual(p.spans, [P, text("a"), todo(true), text("b"), todo(true), text("b"), P, text("c")]);

  p.at(2);
  p.run(toggleBlockMenu());
  p.type("del");
  p.key("Enter");
  assert.deepEqual(p.spans, [todo(true), text("b"), todo(true), text("b"), P, text("c")]);
  assert.ok(p.state.selection instanceof TextSelection);
  assert.equal(p.menu(), null);
});

test("deleting the only block, or the one after a page block, leaves an empty paragraph", async () => {
  const p = await menuPage([P, text("only")]);
  p.at(2);
  p.run(toggleBlockMenu());
  p.type("del");
  p.key("Enter");
  assert.deepEqual(p.spans, [P]);

  const id = newPageId();
  const q = await menuPage([P, text("x"), pageOf(id), P, text("last")]);
  q.at(2 + 2 + 3);
  q.run(toggleBlockMenu());
  q.type("del");
  q.key("Enter");
  assert.deepEqual(q.spans, [P, text("x"), pageOf(id), P], "the body still ends with a line");
});

test("a page block's menu opens it, and deleting it goes through the page guard, which closes the menu on blur", async () => {
  const id = newPageId();
  const asked: PageId[][] = [];
  const guard = new Plugin({
    filterTransaction(tr) {
      const ids = removedPages(tr, () => true);
      if (ids.length > 0) asked.push(ids);
      return ids.length === 0;
    },
  });
  const p = await menuPage([P, text("x"), pageOf(id), P], newPageId, [guard]);
  p.view.dispatch(p.state.tr.setSelection(NodeSelection.create(p.state.doc, 3)));
  p.run(toggleBlockMenu());
  assert.deepEqual(labels(p.menu()), ["Open", "Delete"]);
  p.key("Enter");
  assert.deepEqual(p.opened, [id]);
  assert.equal(p.menu(), null);
  assert.ok(p.state.selection instanceof NodeSelection, "the card stays selected");

  p.run(toggleBlockMenu());
  p.key("ArrowDown");
  p.key("Enter");
  assert.deepEqual(asked, [[id]], "the guard was asked");
  assert.deepEqual(p.spans, [P, text("x"), pageOf(id), P], "and nothing changed");
  assert.equal(p.menu()?.kind, "block", "the menu waits until the confirm takes focus");
  p.blur();
  assert.equal(p.menu(), null);
  assert.ok(p.state.selection instanceof NodeSelection && p.state.selection.from === 3);
});

test("the gutter's + opens a / menu on a new line, and Escape takes the / back out unless a query was typed", async () => {
  const p = await menuPage([P, text("x")]);
  p.at(2);
  assert.ok(p.run(addBlock(0)));
  assert.deepEqual(p.spans, [P, text("x"), P, text("/")]);
  assert.equal(p.menu()?.kind, "slash");
  p.key("Escape");
  assert.deepEqual(p.spans, [P, text("x"), P], "the new empty line stays");
  assert.equal(p.menu(), null);

  p.run(addBlock(0));
  assert.deepEqual(p.spans, [P, text("x"), P, text("/"), P], "after the block, before the empty line");
  p.key("Escape");

  p.at(4);
  p.run(addBlock(3));
  assert.deepEqual(p.spans, [P, text("x"), P, text("/"), P], "an empty line is used as it is");
  p.type("head");
  p.key("Enter");
  assert.deepEqual(p.spans, [P, text("x"), block(H1), P]);

  p.run(addBlock(0));
  p.type("x");
  p.key("Escape");
  assert.deepEqual(p.spans.slice(0, 5), [P, text("x"), P, text("/x"), block(H1)], "a typed query keeps the text");
  assert.equal(p.menu(), null);

  const q = await menuPage([P, text("y")]);
  q.at(1);
  q.run(addBlock(0));
  q.blur();
  assert.deepEqual(q.spans, [P, text("y"), P], "blur takes it out too");
});

test("typing filters the block menu, Backspace and Delete never reach the block, and a letter that matches nothing is dropped", async () => {
  const p = await menuPage([P, text("keep")]);
  p.at(3);
  p.run(toggleBlockMenu());
  assert.deepEqual(labels(p.menu()), ["Text", "Heading 1", "Heading 2", "Heading 3", "Bulleted list", "Numbered list", "To-do list", "Duplicate", "Delete"]);
  p.type("he");
  assert.deepEqual(labels(p.menu()), ["Heading 1", "Heading 2", "Heading 3"]);
  p.type("z");
  assert.equal(p.menu()?.query, "he", "nothing matches hez");
  p.key("ArrowDown");
  assert.equal(p.menu()?.index, 1);
  assert.ok(p.key("Backspace"));
  assert.equal(p.menu()?.query, "h");
  assert.ok(p.key("Backspace"));
  assert.ok(p.key("Backspace"), "an empty query still swallows it");
  assert.ok(p.key("Delete"));
  assert.deepEqual(p.spans, [P, text("keep")]);
  p.type("ul");
  assert.deepEqual(labels(p.menu()), ["Bulleted list"], "a keyword matches by prefix");
});

test("a remote retype keeps the block selected, and the menu follows it", async () => {
  const p = await menuPage([P, text("a"), P, text("b")]);
  p.at(5);
  p.run(toggleBlockMenu());
  p.remote([{ type: "setBlock", at: 2, block: todoBlock(true) }]);
  assert.ok(p.state.selection instanceof NodeSelection && p.state.selection.from === 3, "still the same block");
  assert.equal(p.menu()?.kind, "block");
  assert.equal(currentOf(p.menu()), labels(p.menu())?.indexOf("To-do list"));

  p.remote([{ type: "setBlock", at: 2, block: H1 }]);
  assert.equal(currentOf(p.menu()), labels(p.menu())?.indexOf("Heading 1"));

  p.remote([{ type: "insert", at: 4, text: "!", marks: {} }]);
  assert.ok(p.state.selection instanceof NodeSelection && p.state.selection.node.textContent === "b!");

  p.remote([{ type: "split", at: 2, block: { type: "paragraph" } }]);
  assert.ok(p.state.selection instanceof NodeSelection && p.state.selection.node.textContent === "b!", "a block inserted above shifts it");
  assert.equal(p.menu()?.kind, "block");
  p.key("Escape");
  assert.deepEqual(p.spans.map((s) => (s.type === "text" ? s.text : s.block.type)), ["paragraph", "a", "paragraph", "heading", "b!"]);
});

test("a remote delete of the block closes its menu and leaves the new selection alone", async () => {
  const p = await menuPage([P, text("a"), P, text("b")]);
  p.at(5);
  p.run(toggleBlockMenu());
  p.remote([{ type: "delete", at: 2, count: 2 }]);
  assert.equal(p.menu(), null);
  assert.ok(!(p.state.selection instanceof NodeSelection));
  assert.equal(p.run(runMenu(0, { createPage: newPageId, openPage: () => {} })), false, "a late click finds no menu");
});
