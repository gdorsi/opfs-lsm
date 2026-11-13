import { readFileSync } from "node:fs";
import { relative } from "node:path";
import type MarkdownIt from "markdown-it";
import { ratioTone } from "../stageshow/adapters/tone.ts";
import { repoRoot } from "./pages.ts";
import { FIGURES } from "./theme/figures.ts";

/**
 * How the site draws what the Markdown sources keep plain for GitHub: byte layouts (```layout), the storage tree
 * (```tree), `<!-- figure: name -->` lines, and table cells by what they hold.
 */

type Token = ReturnType<MarkdownIt["parse"]>[number];

type Field = { type?: string; name: string };
type LayoutRow = { parts: Field[]; meaning?: string; when?: string } | "repeat";
type LayoutGroup = { label?: string; rows: LayoutRow[] };

type TreeLine = { mapping?: [string, string]; note?: string };
type TreeEntry = { name: string; lines: TreeLine[] };
type TreeRoot = { kind: string; path: string; entries: TreeEntry[] };

/** A line a grammar does not cover. `line` counts from the block's first line, 0-based. */
class SourceError extends Error {
  readonly line: number;
  constructor(line: number, message: string) {
    super(message);
    this.line = line;
  }
}

const TYPE = /^(u8|u16|u32|u64|varint) (.+)$/;
const columns = (text: string) => text.split(/ {2,}/);

/**
 * A byte layout, one line per field: `| [type] field  [meaning]  [(condition)] |`. A field of several parts joins
 * them with ", ". A line `label:` starts a group, `| ... |` repeats the row above, and blank lines only space groups.
 */
function parseLayout(text: string): LayoutGroup[] {
  const groups: LayoutGroup[] = [{ rows: [] }];
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    const label = /^(\S[^|]*):$/.exec(line);
    if (label) {
      groups.push({ label: label[1], rows: [] });
      return;
    }
    const row = /^\| (.*\S) +\|$/.exec(line);
    if (!row) throw new SourceError(i, `"${line}" is neither "| field |" nor "label:".`);
    const group = groups.at(-1)!;
    if (row[1] === "...") {
      group.rows.push("repeat");
      return;
    }
    const [field, ...rest] = columns(row[1]);
    const when = rest.at(-1)?.match(/^\((.+)\)$/)?.[1];
    if (when) rest.pop();
    if (rest.length > 1 || rest.some((c) => c.startsWith("("))) {
      throw new SourceError(i, `"${line}" has more columns than field, meaning and (condition).`);
    }
    const parts = field!.split(", ").map((part) => {
      const typed = TYPE.exec(part);
      return typed ? { type: typed[1], name: typed[2]! } : { name: part };
    });
    group.rows.push({ parts, meaning: rest[0], when });
  });
  return groups.filter((g) => g.label || g.rows.length > 0);
}

/**
 * Stores and what they hold: a root `Kind  path`, then `├── name  [key -> value]  [note]` entries, and indented
 * `key -> value  [note]` lines that add to the entry above.
 */
function parseTree(text: string): TreeRoot[] {
  const roots: TreeRoot[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/ +-> +/g, " -> ");
    if (line.trim() === "") return;
    const root = /^(\S+) {2,}(\S.*)$/.exec(line);
    if (root) {
      roots.push({ kind: root[1]!, path: root[2]!, entries: [] });
      return;
    }
    const entry = /^ +[├└]── (\S.*)$/.exec(line);
    const more = /^ +([^├└\s].*)$/.exec(line);
    const at = roots.at(-1);
    if (!at || !(entry || more)) throw new SourceError(i, `"${raw}" is neither a root, a "├── name" entry nor a "key -> value" line under one.`);
    const cells = columns((entry ?? more)![1]!);
    if (entry) at.entries.push({ name: cells.shift()!, lines: [] });
    const target = at.entries.at(-1);
    if (!target) throw new SourceError(i, `"${raw}" continues an entry, but its root has none yet.`);
    const mapping = cells[0]?.includes(" -> ") ? (cells.shift()!.split(" -> ") as [string, string]) : undefined;
    if (cells.length > 1 || (more && !mapping)) throw new SourceError(i, `"${raw}" is not "[name]  key -> value  [note]".`);
    if (mapping || cells[0]) target.lines.push({ mapping, note: cells[0] });
  });
  return roots;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function layoutHtml(groups: LayoutGroup[]) {
  const row = (r: LayoutRow) => {
    if (r === "repeat") return `<tr class="bl-repeat"><td></td><td>…</td><td></td></tr>`;
    const tag = r.when ? ` <span class="bl-when">${esc(r.when)}</span>` : "";
    return r.parts
      .map((p, i) => {
        const meaning = i === 0 ? `<td class="bl-meaning" rowspan="${r.parts.length}">${esc(r.meaning ?? "")}${tag}</td>` : "";
        return `<tr><td class="bl-type">${esc(p.type ?? "")}</td><td class="bl-field">${esc(p.name)}</td>${meaning}</tr>`;
      })
      .join("");
  };
  const body = groups
    .map((g) => {
      const head = g.label ? `<tr class="bl-group"><th colspan="3">${esc(g.label)}</th></tr>` : "";
      return `<tbody>${head}${g.rows.map(row).join("")}</tbody>`;
    })
    .join("");
  return `<div class="byte-layout"><table>${body}</table></div>\n`;
}

function treeHtml(roots: TreeRoot[]) {
  const line = (l: TreeLine) => {
    const map = l.mapping ? `<code class="fs-map">${esc(l.mapping[0])}<span> → </span>${esc(l.mapping[1])}</code>` : "";
    const note = l.note ? `<span class="fs-note">${esc(l.note)}</span>` : "";
    return `<div class="fs-line">${map}${note}</div>`;
  };
  const entry = (e: TreeEntry) =>
    `<li class="${e.lines.some((l) => l.mapping) ? "fs-mapped" : ""}"><code class="fs-name">${esc(e.name)}</code>${e.lines.map(line).join("")}</li>`;
  const card = (r: TreeRoot) =>
    `<section class="fs-root"><header><span class="fs-kind">${esc(r.kind)}</span><code>${esc(r.path)}</code></header><ul>${r.entries.map(entry).join("")}</ul></section>`;
  return `<div class="fs-tree">${roots.map(card).join("")}</div>\n`;
}

const fences: Record<string, (text: string) => string> = {
  layout: (text) => layoutHtml(parseLayout(text)),
  tree: (text) => treeHtml(parseTree(text)),
};

function figureHtml(token: Token): string | undefined {
  const m = /^<!--\s*figure:\s*(\S+)\s*-->\s*$/.exec(token.content);
  if (!m) return undefined;
  if (!(m[1]! in FIGURES)) {
    throw new SourceError(0, `"${m[1]}" is not a figure. Name one of ${Object.keys(FIGURES).join(", ")} (site/.vitepress/theme/figures.ts).`);
  }
  return `<Illustration name="${m[1]}" />\n`;
}

const RATIO = /^\d+(?:\.\d+)?×$/;
const MEASURE = /^\d[\d,]*(?:\.\d+)?[kMG]?(?: [A-Za-z]+(?:\/[a-z]+)?)?$/;

type Cell = "num" | "ratio" | "code" | "text";

function cellOf(inline: Token): Cell {
  const children = inline.children ?? [];
  if (children.every((c) => ["text", "strong_open", "strong_close"].includes(c.type))) {
    const text = children.map((c) => c.content).join("");
    if (RATIO.test(text)) return "ratio";
    if (MEASURE.test(text)) return "num";
  }
  const shown = children.filter((c) => c.type !== "link_open" && c.type !== "link_close");
  return shown.length > 0 && shown.every((c) => c.type === "code_inline") ? "code" : "text";
}

/**
 * Classes each cell by what it holds. Numbers keep to one line in tabular figures, and a column whose cells are all
 * numbers aligns them, and its header, to the right. A table of six columns or more is dense.
 */
function classifyTable(tokens: Token[], open: number, html: (content: string) => Token) {
  const heads: Token[] = [];
  const columns: { open: Token; cell: Cell }[][] = [];
  let col = 0;
  for (let i = open + 1; tokens[i]!.type !== "table_close"; i++) {
    const t = tokens[i]!;
    if (t.type === "tr_open") col = 0;
    if (t.type === "th_open") heads[col++] = t;
    if (t.type !== "td_open") continue;
    const inline = tokens[i + 1]!;
    const cell = cellOf(inline);
    (columns[col++] ??= []).push({ open: t, cell });
    if (cell === "ratio") {
      const tone = ratioTone(inline.children!.map((c) => c.content).join(""));
      inline.children = [html(`<span class="ratio" data-tone="${tone}">`), ...inline.children!, html("</span>")];
    }
  }
  if (heads.length >= 6) tokens[open]!.attrJoin("class", "dense");
  columns.forEach((cells, c) => {
    const numeric = cells.every(({ cell }) => cell === "num" || cell === "ratio");
    if (numeric) heads[c]?.attrJoin("class", "num");
    for (const { open: td, cell } of cells) {
      if (cell === "text") continue;
      td.attrJoin("class", cell === "code" ? "nowrap" : numeric ? "num" : "figure");
    }
  });
}

export const docRules = (md: MarkdownIt) => {
  md.core.ruler.push("opfs-lsm-docs", (state) => {
    const html = (content: string) => Object.assign(new state.Token("html_inline", "", 0), { content });
    const file: string = state.env.realPath ?? state.env.path ?? "";
    for (const [i, t] of state.tokens.entries()) {
      try {
        if (t.type === "table_open") classifyTable(state.tokens, i, html);
        const render = t.type === "fence" ? fences[t.info.trim()] : undefined;
        const figure = t.type === "html_block" ? figureHtml(t) : undefined;
        if (!render && !figure) continue;
        const content = render ? render(t.content) : figure!;
        Object.assign(t, { type: "html_block", tag: "", info: "", content });
      } catch (e) {
        if (!(e instanceof SourceError)) throw e;
        const stripped = file ? readFileSync(file, "utf8").split("\n").length - state.src.split("\n").length : 0;
        const fenceLine = t.type === "fence" ? 1 : 0;
        const at = `${relative(repoRoot, file)}:${stripped + (t.map?.[0] ?? 0) + fenceLine + e.line + 1}`;
        throw new Error(`${at}: ${e.message}`);
      }
    }
  });
  md.renderer.rules.table_open = (tokens, idx, options, _env, self) => `<div class="table-scroll">${self.renderToken(tokens, idx, options)}`;
  md.renderer.rules.table_close = (tokens, idx, options, _env, self) => `${self.renderToken(tokens, idx, options)}</div>`;
};
