import { Schema, type Attrs, type DOMOutputSpec, type Fragment, type Mark, type Node as PMNode } from "prosemirror-model";
import type { Block, Depth, MarkName, Marks, Span } from "../model/types.ts";

const MAX_DEPTH = 5;

const clampDepth = (n: number): Depth => Math.max(0, Math.min(MAX_DEPTH, Number.isFinite(n) ? Math.trunc(n) : 0)) as Depth;
const depthOf = (dom: HTMLElement): Depth => clampDepth(Number(dom.getAttribute("data-depth") ?? 0));

function liDepth(dom: HTMLElement): Depth {
  let lists = 0;
  for (let el = dom.parentElement; el; el = el.parentElement) if (el.tagName === "UL" || el.tagName === "OL") lists++;
  return clampDepth(lists - 1);
}

export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "text*",
      parseDOM: [{ tag: "p" }],
      toDOM: (): DOMOutputSpec => ["p", 0],
    },
    heading: {
      group: "block",
      content: "text*",
      defining: true,
      attrs: { level: { default: 1 } },
      parseDOM: [
        { tag: "h1", attrs: { level: 1 } },
        { tag: "h2", attrs: { level: 2 } },
        { tag: "h3", attrs: { level: 3 } },
        { tag: "h4", attrs: { level: 3 } },
        { tag: "h5", attrs: { level: 3 } },
        { tag: "h6", attrs: { level: 3 } },
      ],
      toDOM: (node): DOMOutputSpec => [`h${node.attrs.level}`, 0],
    },
    item: {
      group: "block",
      content: "text*",
      defining: true,
      attrs: { list: { default: "bullet" }, depth: { default: 0 } },
      parseDOM: [
        {
          tag: "div.item",
          getAttrs: (dom) => ({ list: dom.getAttribute("data-list") === "number" ? "number" : "bullet", depth: depthOf(dom) }),
        },
        {
          tag: "li",
          getAttrs: (dom) => (dom.querySelector(":scope > input[type=checkbox]") ? false : { list: dom.parentElement?.tagName === "OL" ? "number" : "bullet", depth: liDepth(dom) }),
        },
      ],
      toDOM: (node): DOMOutputSpec => ["div", { class: "item", "data-list": node.attrs.list, "data-depth": String(node.attrs.depth) }, 0],
    },
    todo: {
      group: "block",
      content: "text*",
      defining: true,
      attrs: { depth: { default: 0 }, checked: { default: false } },
      parseDOM: [
        {
          tag: "div.todo",
          contentElement: "span.text",
          getAttrs: (dom) => ({ depth: depthOf(dom), checked: dom.getAttribute("data-checked") === "true" }),
        },
        {
          tag: "li",
          getAttrs: (dom) => {
            const box = dom.querySelector<HTMLInputElement>(":scope > input[type=checkbox]");
            return box ? { depth: liDepth(dom), checked: box.checked } : false;
          },
        },
      ],
      toDOM: (node): DOMOutputSpec => [
        "div",
        { class: "todo", "data-depth": String(node.attrs.depth), "data-checked": String(node.attrs.checked) },
        ["span", { class: "check", contenteditable: "false" }],
        ["span", { class: "text" }, 0],
      ],
    },
    text: {},
  },
  marks: {
    bold: {
      parseDOM: [{ tag: "strong" }, { tag: "b", getAttrs: (dom) => dom.style.fontWeight !== "normal" && null }],
      toDOM: (): DOMOutputSpec => ["strong", 0],
    },
    italic: {
      parseDOM: [{ tag: "em" }, { tag: "i" }],
      toDOM: (): DOMOutputSpec => ["em", 0],
    },
    code: {
      parseDOM: [{ tag: "code" }],
      toDOM: (): DOMOutputSpec => ["code", 0],
    },
    link: {
      attrs: { href: {} },
      inclusive: false,
      parseDOM: [{ tag: "a[href]", getAttrs: (dom) => ({ href: dom.getAttribute("href") }) }],
      toDOM: (mark): DOMOutputSpec => ["a", { href: mark.attrs.href, rel: "noopener noreferrer nofollow" }, 0],
    },
  },
});

export function blockOf(node: PMNode): Block {
  const a = node.attrs;
  switch (node.type.name) {
    case "heading":
      return { type: "heading", level: a.level };
    case "item":
      return { type: "item", list: a.list, depth: a.depth };
    case "todo":
      return { type: "todo", depth: a.depth, checked: a.checked };
    default:
      return { type: "paragraph" };
  }
}

export function nodeTypeOf(block: Block): { readonly type: PMNode["type"]; readonly attrs: Attrs } {
  const { type, ...attrs } = block;
  return { type: schema.nodes[type]!, attrs };
}

function blockNode(block: Block, content?: Fragment | readonly PMNode[]): PMNode {
  const { type, attrs } = nodeTypeOf(block);
  return type.create(attrs, content as Fragment | PMNode[] | undefined);
}

export function marksOf(marks: readonly Mark[]): Marks {
  const out: { -readonly [N in MarkName]?: Marks[N] } = {};
  for (const mark of marks) {
    const name = mark.type.name as MarkName;
    if (name === "link") out.link = mark.attrs.href;
    else out[name] = true;
  }
  return out;
}

export function markOf(name: MarkName, value: string | true): Mark {
  return name === "link" ? schema.marks.link!.create({ href: value }) : schema.marks[name]!.create();
}

export function pmMarks(marks: Marks): Mark[] {
  return (Object.entries(marks) as [MarkName, string | true | undefined][]).flatMap(([name, value]) => (value === undefined ? [] : [markOf(name, value)]));
}

export function spansToDoc(spans: readonly Span[]): PMNode {
  const blocks: PMNode[] = [];
  let block: Block | null = null;
  let text: PMNode[] = [];
  const close = () => {
    if (block) blocks.push(blockNode(block, text));
  };
  for (const span of spans) {
    if (span.type === "block") {
      close();
      block = span.block;
      text = [];
    } else if (span.text.length > 0) {
      text.push(schema.text(span.text, pmMarks(span.marks)));
    }
  }
  close();
  return schema.nodes.doc!.create(null, blocks);
}

const MARK_NAMES: readonly MarkName[] = ["bold", "italic", "code", "link"];
const sameMarks = (a: Marks, b: Marks) => MARK_NAMES.every((name) => a[name] === b[name]);

export function docToSpans(doc: PMNode): Span[] {
  const out: Span[] = [];
  doc.forEach((block) => {
    out.push({ type: "block", block: blockOf(block) });
    block.forEach((node) => {
      const marks = marksOf(node.marks);
      const last = out.at(-1)!;
      if (last.type === "text" && sameMarks(last.marks, marks)) out[out.length - 1] = { ...last, text: last.text + node.text! };
      else out.push({ type: "text", text: node.text!, marks });
    });
  });
  return out;
}
