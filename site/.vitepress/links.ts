import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { slug } from "github-slugger";
import MarkdownIt from "markdown-it";
import { everyPage, github, home, pageAt, pageOf, pages, repoRoot, url } from "./pages.ts";

const external = /^[a-z][a-z\d+.-]*:|^\/\//i;
const pagesFile = "site/.vitepress/pages.ts";
const numbersFrom = "README.md";

type Heading = { level: number; text: string; slug: string };
type Link = { href: string; line: number };
type Source = { headings: Heading[]; anchors: Set<string>; links: Link[] };
type Resolved = { href: string } | { problem: string };

export const githubSlug = (text: string) => slug(text);

const plain = new MarkdownIt();
const parsed = new Map<string, { mtimeMs: number; source: Source }>();

function frontmatterLines(text: string) {
  const m = /^---\n[\s\S]*?\n---\n/.exec(text);
  return m ? m[0].split("\n").length - 1 : 0;
}

function sourceOf(file: string): Source {
  const abs = join(repoRoot, file);
  const { mtimeMs } = statSync(abs);
  const hit = parsed.get(file);
  if (hit?.mtimeMs === mtimeMs) return hit.source;

  const text = readFileSync(abs, "utf8");
  const skipped = frontmatterLines(text);
  const lines = text.split("\n").slice(skipped);
  const tokens = plain.parse(lines.join("\n"), {});
  const seen = new Map<string, number>();
  const source: Source = { headings: [], anchors: new Set(), links: [] };
  tokens.forEach((t, i) => {
    if (t.type === "heading_open") {
      const heading = textOf(tokens[i + 1]);
      const base = githubSlug(heading);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const id = n === 0 ? base : `${base}-${n}`;
      source.headings.push({ level: Number(t.tag.slice(1)), text: heading, slug: id });
      source.anchors.add(id);
    }
    for (const c of t.children ?? []) {
      if (c.type !== "link_open") continue;
      const href = c.attrGet("href") ?? "";
      source.links.push({ href, line: skipped + lineIn(lines, t.map, href) + 1 });
    }
  });
  parsed.set(file, { mtimeMs, source });
  return source;
}

function textOf(inline: { children: { type: string; content: string }[] | null }) {
  return (inline.children ?? [])
    .filter((c) => c.type === "text" || c.type === "code_inline")
    .map((c) => c.content)
    .join("");
}

function lineIn(lines: string[], map: number[] | null, href: string) {
  if (!map) return 0;
  const at = lines.slice(map[0], map[1]).findIndex((l) => l.includes(href));
  return map[0] + Math.max(at, 0);
}

export const headingsOf = (file: string) => sourceOf(file).headings;

export const outlineOf = (file: string): [number, number] =>
  headingsOf(file).filter((h) => h.level === 1).length > 1 ? [1, 2] : [2, 3];

function resolveHref(from: string, href: string): Resolved {
  if (external.test(href)) return { href };
  const cut = href.indexOf("#");
  const path = cut < 0 ? href : href.slice(0, cut);
  const rawHash = cut < 0 ? "" : href.slice(cut + 1);
  const hash = decode(rawHash);
  const problem = (why: string): Resolved => ({ problem: `link "${href}" ${why}` });

  if (path === "") {
    if (hash === "" || sourceOf(from).anchors.has(hash)) return { href };
    return problem(`names no heading in ${from}. Fix the anchor, or restore the heading.`);
  }
  if (path.startsWith("/")) {
    return problem("is root-relative, which breaks on GitHub. Write it relative to this file.");
  }
  const target = posix.normalize(posix.join(posix.dirname(from), path)).replace(/\/$/, "");
  if (target.startsWith("..")) return problem("points outside the repository. Fix the path.");
  const abs = join(repoRoot, target);
  if (!existsSync(abs)) {
    return problem(`points to ${target}, which does not exist. Fix the path, or restore the file.`);
  }
  const isDir = statSync(abs).isDirectory();
  const file = isDir && existsSync(join(abs, "README.md")) ? posix.join(target, "README.md") : target;
  if (hash && file.endsWith(".md") && !sourceOf(file).anchors.has(hash)) {
    return problem(`names no heading "#${hash}" in ${file}. Fix the anchor, or restore the heading.`);
  }
  const suffix = rawHash ? `#${rawHash}` : "";
  const page = pageOf(file);
  if (page) return { href: url(page) + suffix };
  return { href: `${github}/${isDir ? "tree" : "blob"}/main/${target}${suffix}` };
}

function decode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export const linkRule = (strict: boolean) => (md: MarkdownIt) => {
  md.core.ruler.push("opfs-lsm-links", (state) => {
    const file: string | undefined = state.env.realPath ?? state.env.path;
    if (!file) return;
    const from = relative(repoRoot, file).split("\\").join("/");
    const lines = state.src.split("\n");
    for (const block of state.tokens) {
      for (const t of block.children ?? []) {
        if (t.type !== "link_open") continue;
        const href = t.attrGet("href") ?? "";
        const resolved = resolveHref(from, href);
        if ("href" in resolved) {
          t.attrSet("href", resolved.href);
          continue;
        }
        const stripped = readFileSync(file, "utf8").split("\n").length - lines.length;
        const message = `${from}:${stripped + lineIn(lines, block.map, href) + 1}: ${resolved.problem}`;
        if (strict) throw new Error(message);
        console.error(message);
      }
    }
  });
};

function problems(): string[] {
  const found: string[] = [];
  const registry = readFileSync(join(repoRoot, pagesFile), "utf8").split("\n");
  const atEntry = (needle: string, nth = 0) => {
    let seen = -1;
    const i = registry.findIndex((l) => l.includes(needle) && ++seen === nth);
    return `${pagesFile}:${i + 1}`;
  };

  const sources = new Map<string, number>();
  const routes = new Map<string, string>();
  for (const p of everyPage) {
    const nth = sources.get(p.source) ?? 0;
    sources.set(p.source, nth + 1);
    if (nth > 0) found.push(`${atEntry(`"${p.source}"`, nth)}: source "${p.source}" is listed twice. Remove one entry.`);
    const other = routes.get(p.route);
    if (other !== undefined && other !== p.source) {
      found.push(`${atEntry(`route: "${p.route}"`, 1)}: route "${p.route}" is used by ${other} and ${p.source}. Give each page its own route.`);
    }
    routes.set(p.route, p.source);
  }

  for (const p of everyPage) {
    if (!existsSync(join(repoRoot, p.source))) {
      if (p !== home) found.push(`${atEntry(`"${p.source}"`)}: source "${p.source}" does not exist. Fix the path, or remove the entry.`);
      else found.push(`${pagesFile}: ${p.source} does not exist. Restore the home page.`);
      continue;
    }
    for (const { href, line } of sourceOf(p.source).links) {
      const r = resolveHref(p.source, href);
      if ("problem" in r) found.push(`${p.source}:${line}: ${r.problem}`);
    }
  }
  if (existsSync(join(repoRoot, home.source))) found.push(...homeProblems());
  return found;
}

function homeProblems(): string[] {
  const found: string[] = [];
  const readme = readFileSync(join(repoRoot, numbersFrom), "utf8");
  const lines = readFileSync(join(repoRoot, home.source), "utf8").split("\n");
  const frontEnd = lines.indexOf("---", 1);
  lines.forEach((line, i) => {
    const at = `${home.source}:${i + 1}`;
    const link = /^\s*(?:- )?link:\s*"?([^"\s]+)"?\s*$/.exec(line);
    if (link) {
      const bad = siteLinkProblem(link[1]);
      if (bad) found.push(`${at}: link "${link[1]}" ${bad}`);
      return;
    }
    if (/^\s*(?:- )?(?:theme|layout):/.test(line) || line === "---") return;
    const prose = i < frontEnd ? line.replace(/^\s*(?:- )?\w+:/, "") : line.replace(/\]\([^)]*\)/g, "]");
    for (const [number] of prose.matchAll(/\d(?:[\d,.]*\d)?[k×%]?/g)) {
      const verbatim = new RegExp(`(?<![\\d.,])${number.replace(/[.×]/g, "\\$&")}(?!\\d)`);
      if (!verbatim.test(readme)) found.push(`${at}: "${number}" does not appear in ${numbersFrom}. Update the home copy to match it.`);
    }
  });
  return found;
}

function siteLinkProblem(link: string): string | undefined {
  if (external.test(link)) return undefined;
  const cut = link.indexOf("#");
  const path = cut < 0 ? link : link.slice(0, cut);
  const hash = cut < 0 ? "" : decode(link.slice(cut + 1));
  const page = pageAt(path);
  if (!page) return `names no page. Use a route from ${pagesFile}, such as ${url(pages[0])}.`;
  if (hash && !sourceOf(page.source).anchors.has(hash)) {
    return `names no heading "#${hash}" in ${page.source}. Fix the anchor, or restore the heading.`;
  }
}

export function checkSite() {
  const found = problems();
  if (found.length === 0) return;
  const noun = found.length === 1 ? "problem" : "problems";
  throw new Error(`The docs site has ${found.length} ${noun}:\n${found.map((p) => `  ${p}`).join("\n")}\n`);
}

export function unregistered(builtSources: string[]) {
  const stray = builtSources.filter((s) => !pageOf(s));
  if (stray.length === 0) return;
  throw new Error(
    `The build includes pages the registry does not list: ${stray.join(", ")}. List them in ${pagesFile}, or exclude them from the site.`,
  );
}
