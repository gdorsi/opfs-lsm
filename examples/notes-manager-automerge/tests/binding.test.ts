import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel";
import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { deleteSelection, joinBackward, joinForward, setBlockType, splitBlock, splitBlockAs, toggleMark } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { textblockTypeInputRule } from "prosemirror-inputrules";
import { Fragment, Slice } from "prosemirror-model";
import { AllSelection, TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import { ReplaceAroundStep } from "prosemirror-transform";
import { applyLocal, bodyState, localEdits, remoteTransaction, UnsupportedStep } from "../src/editor/binding.ts";
import { docToSpans, schema } from "../src/editor/schema.ts";
import { newPageId } from "../src/model/bodies.ts";
import { openNotes } from "../src/model/notes.ts";
import { EXPAND } from "../src/model/text-edits.ts";
import type { PageBody, TextEdit } from "../src/model/types.ts";
import { memoryStorage } from "../src/storage/memory.ts";
import { random } from "../src/testing/random-edits.ts";
import { referenceBody } from "../src/testing/reference.ts";

type Command = (state: EditorState, dispatch: (tr: Transaction) => void) => unknown;

function editor(body: PageBody) {
  const oracle = referenceBody();
  const steps = new Map<string, number>();
  const tee = {
    edit(edits: readonly TextEdit[]) {
      oracle.edit(edits);
      body.edit(edits);
    },
  };
  let state = bodyState(body, [history()]);
  return {
    get state() {
      return state;
    },
    steps,
    run(command: Command, label: string) {
      command(state, (tr) => {
        for (const step of tr.steps) steps.set(step.constructor.name, (steps.get(step.constructor.name) ?? 0) + 1);
        state = applyLocal(tee, state, tr);
      });
      const pm = docToSpans(state.doc);
      assert.deepEqual(oracle.spans(), pm, `${label}: the oracle equals PM`);
      assert.deepEqual(body.spans(), pm, `${label}: the model equals PM`);
    },
  };
}

const select = (from: number, to = from): Command => (s, d) => d(s.tr.setSelection(TextSelection.create(s.doc, from, to)));
const type = (text: string): Command => (s, d) => d(s.tr.insertText(text));
const tr = (build: (s: EditorState) => Transaction): Command => (s, d) => d(build(s));
const blockStart = (s: EditorState) => s.selection.$from.start(1);
const blockEnd = (s: EditorState) => s.selection.$from.end(1);

test("a mark extends to typed text in PM exactly when Automerge expands it", () => {
  for (const [name, expand] of Object.entries(EXPAND)) assert.equal(schema.marks[name]!.spec.inclusive ?? true, expand === "after", name);
});

test("every editing command keeps the oracle, the model and PM equal", async (t) => {
  const notes = await openNotes({ storage: memoryStorage() });
  t.after(() => notes.close());
  const e = editor(await notes.bodies.open(newPageId()));
  const run = (command: Command, label: string) => e.run(command, label);
  const size = () => e.state.doc.content.size;

  run(type("Hello world"), "type");
  run(select(3, 8), "select");
  run(toggleMark(schema.marks.bold!), "bold");
  run(toggleMark(schema.marks.italic!), "italic");
  run(select(4), "caret");
  run(splitBlock, "Enter mid-block");
  run(type("x"), "type after the split");
  run(select(size() - 1), "end");
  run(splitBlock, "Enter at the end");
  run(setBlockType(schema.nodes.heading!, { level: 2 }), "heading");
  run(type("Title"), "type in the heading");
  run(setBlockType(schema.nodes.item!, { list: "number", depth: 0 }), "numbered item");
  run(tr((s) => s.tr.setNodeAttribute(s.selection.$from.before(1), "depth", 2)), "Tab sets depth");
  run(setBlockType(schema.nodes.todo!, { depth: 1, checked: false }), "todo");
  run(tr((s) => s.tr.setNodeAttribute(s.selection.$from.before(1), "checked", true)), "check the todo");
  run(tr((s) => s.tr.setSelection(TextSelection.create(s.doc, blockStart(s)))), "block start");
  run(joinBackward, "Backspace joins");
  run(tr((s) => s.tr.setSelection(TextSelection.create(s.doc, s.doc.child(0).nodeSize - 1))), "end of the first block");
  run(joinForward, "Delete joins");

  run(type("A"), "A");
  run(splitBlock, "Enter");
  run(type("B"), "B");
  run(splitBlock, "Enter");
  run(type("C"), "C");
  run(select(2, size() - 2), "select across blocks");
  run(deleteSelection, "delete across blocks");

  run(tr((s) => s.tr.addMark(1, 3, schema.marks.link!.create({ href: "https://a.example" }))), "link");
  run(tr((s) => s.tr.addMark(1, 3, schema.marks.link!.create({ href: "https://b.example" }))), "relink");
  run(select(1), "doc start");
  run(splitBlock, "a new first block");
  run(select(1), "into the first block");
  run(type("#"), "#");
  const rule = textblockTypeInputRule(/^#\s$/, schema.nodes.heading!, { level: 1 }) as unknown as {
    handler: (state: EditorState, match: string[], start: number, end: number) => Transaction | null;
  };
  run((s, d) => {
    const ruleTr = rule.handler(s, ["# "], 1, 2);
    if (ruleTr) d(ruleTr);
  }, "input rule '# '");

  run(tr((s) => s.tr.setSelection(new AllSelection(s.doc))), "select all");
  run(type("replaced"), "select all, then type");
  run(splitBlock, "Enter");
  run(type("two"), "two");
  run(tr((s) => s.tr.setSelection(new AllSelection(s.doc))), "select all");
  run(deleteSelection, "select all, then delete");

  run(type("abcdef"), "abcdef");
  run(select(4), "mid-block");
  const pasted = new Slice(
    Fragment.from([
      schema.nodes.paragraph!.create(null, schema.text("P1", [schema.marks.bold!.create()])),
      schema.nodes.heading!.create({ level: 3 }, schema.text("H")),
      schema.nodes.todo!.create({ depth: 0, checked: true }, schema.text("T")),
    ]),
    1,
    1,
  );
  run(tr((s) => s.tr.replaceSelection(pasted)), "paste blocks mid-block");
  run(tr((s) => s.tr.insert(0, schema.nodes.heading!.create({ level: 1 }, schema.text("Top")))), "insert a block at 0");
  run(tr((s) => s.tr.replaceWith(0, s.doc.child(0).nodeSize, schema.nodes.item!.create({ list: "bullet", depth: 0 }, schema.text("I")))), "replace the first block");
  run(tr((s) => s.tr.delete(0, s.doc.child(0).nodeSize)), "delete the first block whole");

  for (let i = 0; i < 6; i++) run(undo, `undo ${i}`);
  for (let i = 0; i < 3; i++) run(redo, `redo ${i}`);
  run(select(1, size() - 1), "select all text");
  run(toggleMark(schema.marks.code!), "code over several runs");
  run(undo, "undo the mark");
  run(redo, "redo the mark");

  run(setBlockType(schema.nodes.item!, { list: "bullet", depth: 1 }), "bullet");
  run(tr((s) => s.tr.setSelection(TextSelection.create(s.doc, blockEnd(s)))), "end of the item");
  run(splitBlockAs((node) => (node.type.name === "item" ? { type: node.type, attrs: node.attrs } : null)), "Enter continues the list");

  for (const kind of ["ReplaceStep", "ReplaceAroundStep", "AttrStep", "AddMarkStep", "RemoveMarkStep", "MarkSetStep"]) {
    assert.ok(e.steps.has(kind), `the scenario makes a ${kind} (made: ${[...e.steps.keys()].join(", ")})`);
  }
});

const BLOCKS = [
  { type: "paragraph" },
  { type: "heading", level: 1 },
  { type: "heading", level: 3 },
  { type: "item", list: "bullet", depth: 0 },
  { type: "item", list: "number", depth: 2 },
  { type: "todo", depth: 1, checked: false },
] as const;

/** One random user action against `state`. A caret never sits inside a surrogate pair, so neither does this. */
function randomCommand(r: () => number, state: EditorState): Command {
  const size = state.doc.content.size;
  const pos = () => {
    const p = 1 + Math.floor(r() * (size - 1));
    const $p = state.doc.resolve(p);
    if (!$p.parent.isTextblock) return 1;
    const before = $p.parent.textContent.charCodeAt($p.parentOffset - 1);
    return before >= 0xd800 && before <= 0xdbff ? p + 1 : p;
  };
  const range = () => {
    const a = pos();
    const b = pos();
    return [Math.min(a, b), Math.max(a, b)] as const;
  };
  const k = r();
  if (k < 0.28) {
    const p = pos();
    const text = ["a", "bc", "xyz ", "é", "😀"][Math.floor(r() * 5)]!;
    return (s, d) => d(s.tr.setSelection(TextSelection.create(s.doc, p)).insertText(text));
  }
  if (k < 0.38) {
    const [a, b] = range();
    return (s, d) => a < b && d(s.tr.setSelection(TextSelection.create(s.doc, a, b)).deleteSelection());
  }
  if (k < 0.48) {
    const p = pos();
    return (s, d) => {
      const at = s.apply(s.tr.setSelection(TextSelection.create(s.doc, p)));
      splitBlock(at, (split) => d(s.tr.setSelection(TextSelection.create(s.doc, p)).step(split.steps[0]!)));
    };
  }
  if (k < 0.58) {
    const p = pos();
    const { type, ...attrs } = BLOCKS[Math.floor(r() * BLOCKS.length)]!;
    return (s, d) => {
      const retype = s.tr.setBlockType(p, p, schema.nodes[type]!, attrs);
      if (retype.docChanged) d(retype);
    };
  }
  if (k < 0.68) {
    const [a, b] = range();
    const name = (["bold", "italic", "code", "link"] as const)[Math.floor(r() * 4)]!;
    const add = r() < 0.7;
    const href = `https://${Math.floor(r() * 3)}.example`;
    return (s, d) => {
      if (a >= b) return;
      const mark = name === "link" ? schema.marks.link!.create({ href }) : schema.marks[name]!.create();
      const marked = add ? s.tr.addMark(a, b, mark) : s.tr.removeMark(a, b, schema.marks[name]!);
      if (marked.docChanged) d(marked);
    };
  }
  if (k < 0.72) {
    const p = pos();
    return (s, d) => {
      const $p = s.doc.resolve(p);
      if ($p.parent.attrs.depth !== undefined) d(s.tr.setNodeAttribute($p.before(1), "depth", ($p.parent.attrs.depth + 1) % 6));
    };
  }
  if (k < 0.75) {
    const p = pos();
    return (s, d) => {
      const $p = s.doc.resolve(p);
      if ($p.parent.type.name === "todo") d(s.tr.setNodeAttribute($p.before(1), "checked", !$p.parent.attrs.checked));
    };
  }
  if (k < 0.8) {
    const p = pos();
    return (s, d) => joinBackward(s.apply(s.tr.setSelection(TextSelection.create(s.doc, s.doc.resolve(p).start(1)))), d);
  }
  if (k < 0.84) return (s, d) => undo(s, d);
  if (k < 0.87) return (s, d) => redo(s, d);
  if (k < 0.92) {
    const p = pos();
    const n = 1 + Math.floor(r() * 3);
    const openStart = r() < 0.5 ? 1 : 0;
    const openEnd = r() < 0.5 ? 1 : 0;
    return (s, d) => {
      const blocks = Array.from({ length: n }, (_, i) => {
        const { type, ...attrs } = BLOCKS[(i + n) % BLOCKS.length]!;
        return schema.nodes[type]!.create(attrs, schema.text(`p${i}`, i % 2 ? [schema.marks.bold!.create()] : []));
      });
      d(s.tr.setSelection(TextSelection.create(s.doc, p)).replaceSelection(new Slice(Fragment.from(blocks), openStart, openEnd)));
    };
  }
  if (k < 0.96) {
    const i = Math.floor(r() * state.doc.childCount);
    return (s, d) => {
      if (s.doc.childCount < 2) return;
      const k = Math.min(i, s.doc.childCount - 1);
      let at = 0;
      for (let j = 0; j < k; j++) at += s.doc.child(j).nodeSize;
      d(s.tr.delete(at, at + s.doc.child(k).nodeSize));
    };
  }
  return (s, d) => d(s.tr.setSelection(new AllSelection(s.doc)).deleteSelection());
}

test("a fuzz of 5 seeds x 600 random commands keeps the oracle, the model and PM equal", async (t) => {
  for (let seed = 1; seed <= 5; seed++) {
    const r = random(seed);
    const notes = await openNotes({ storage: memoryStorage() });
    t.after(() => notes.close());
    const e = editor(await notes.bodies.open(newPageId()));
    for (let i = 0; i < 600; i++) e.run(randomCommand(r, e.state), `seed ${seed} command ${i}`);
  }
});

test("a peer's edits rebuild the same PM doc, step by step, without spans()", () => {
  for (let seed = 11; seed <= 15; seed++) {
    const r = random(seed);
    const blank = { spans: () => [{ type: "block", block: { type: "paragraph" } }] as const };
    let a = bodyState(blank, [history()]);
    let b = bodyState(blank);
    for (let i = 0; i < 600; i++) {
      randomCommand(r, a)(a, (tr) => {
        const edits = localEdits(tr);
        a = a.apply(tr);
        b = b.apply(remoteTransaction(b, edits));
        assert.ok(a.doc.eq(b.doc), `seed ${seed} command ${i}: the mirror matches\n${JSON.stringify(edits)}`);
      });
    }
  }
});

test("two editors on two Repos converge, each equal to its model", async (t) => {
  for (let seed = 21; seed <= 23; seed++) {
    const r = random(seed);
    const { port1, port2 } = new MessageChannel();
    const A = await openNotes({ storage: memoryStorage(), network: [new MessageChannelNetworkAdapter(port1)] });
    const B = await openNotes({ storage: memoryStorage(), network: [new MessageChannelNetworkAdapter(port2)] });
    t.after(async () => {
      await Promise.all([A.close(), B.close()]);
      port1.close();
      port2.close();
    });
    const id = newPageId();
    const sides = (await Promise.all([A.bodies.open(id), B.bodies.open(id)])).map((body) => {
      const side = { body, state: bodyState(body, [history()]) };
      body.subscribe((edits) => {
        side.state = applyLocal(body, side.state, remoteTransaction(side.state, edits));
      });
      return side;
    });
    for (let round = 0; round < 30; round++) {
      for (const side of sides) {
        const n = 1 + Math.floor(r() * 6);
        for (let i = 0; i < n; i++) {
          randomCommand(r, side.state)(side.state, (tr) => {
            side.state = applyLocal(side.body, side.state, tr);
          });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2 + (round % 3) * 4));
      for (const side of sides) assert.deepEqual(docToSpans(side.state.doc), side.body.spans(), `seed ${seed} round ${round}: PM equals its model`);
    }
    const deadline = Date.now() + 5000;
    while (!isDeepStrictEqual(sides[0]!.body.spans(), sides[1]!.body.spans())) {
      assert.ok(Date.now() < deadline, `seed ${seed}: the two models converge`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const side of sides) assert.deepEqual(docToSpans(side.state.doc), side.body.spans(), `seed ${seed}: PM equals the converged model`);
    assert.ok(sides[0]!.state.doc.eq(sides[1]!.state.doc), `seed ${seed}: both editors show the same doc`);
  }
});

test("an editor reads spans() once, however many local and remote edits follow", async (t) => {
  const { port1, port2 } = new MessageChannel();
  const A = await openNotes({ storage: memoryStorage(), network: [new MessageChannelNetworkAdapter(port1)] });
  const B = await openNotes({ storage: memoryStorage(), network: [new MessageChannelNetworkAdapter(port2)] });
  t.after(async () => {
    await Promise.all([A.close(), B.close()]);
    port1.close();
    port2.close();
  });
  const id = newPageId();
  const [mine, peer] = await Promise.all([A.bodies.open(id), B.bodies.open(id)]);
  let reads = 0;
  const counted = { spans: () => (reads++, mine.spans()), edit: (edits: readonly TextEdit[]) => mine.edit(edits) };
  let state = bodyState(counted, [history()]);
  mine.subscribe((edits) => {
    state = applyLocal(counted, state, remoteTransaction(state, edits));
  });
  const r = random(7);
  for (let i = 0; i < 200; i++) {
    randomCommand(r, state)(state, (tr) => {
      state = applyLocal(counted, state, tr);
    });
    if (i % 20 === 0) peer.edit([{ type: "insert", at: 1, text: "peer", marks: {} }]);
    await new Promise((resolve) => setImmediate(resolve));
  }
  const deadline = Date.now() + 5000;
  while (!isDeepStrictEqual(mine.spans(), peer.spans())) {
    assert.ok(Date.now() < deadline, "the peer's edits arrive");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(docToSpans(state.doc), mine.spans(), "PM followed every edit");
  assert.equal(reads, 1, "spans() ran once, at open");
});

test("a dispatch the body refuses leaves the body and PM where they were", async (t) => {
  const notes = await openNotes({ storage: memoryStorage() });
  t.after(() => notes.close());
  const body = await notes.bodies.open(newPageId());
  body.edit([{ type: "insert", at: 1, text: "keep", marks: {} }]);
  const state = bodyState(body);
  const before = body.spans();

  const end = state.doc.child(0).nodeSize;
  const twoBlocks = new Slice(Fragment.from([schema.nodes.heading!.create(), schema.nodes.paragraph!.create()]), 0, 0);
  const wrap = state.tr.step(new ReplaceAroundStep(0, end, 1, end - 1, twoBlocks, 1, true));
  assert.throws(() => applyLocal(body, state, wrap), UnsupportedStep, "a step outside the table throws UnsupportedStep");
  assert.deepEqual(body.spans(), before, "the unsupported step changed nothing in the body");

  await body.close();
  assert.throws(() => applyLocal(body, state, state.tr.insertText("x", 1)), /closed/, "the model refuses an edit to a closed body");
  assert.deepEqual(docToSpans(state.doc), before, "the caller still holds the state that matches the body");
});
