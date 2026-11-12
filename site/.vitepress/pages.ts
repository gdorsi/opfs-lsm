import { globSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url)).split("\\").join("/");

const repository = JSON.parse(readFileSync(`${repoRoot}package.json`, "utf8")).repository.url as string;
export const github = repository.replace(/^git\+/, "").replace(/\.git$/, "");
export const base = `/${github.split("/").pop()}/`;

type Page = { label: string; source: string; route: string; sidebarSections?: boolean };
type Section = { title: string; nav?: string; pages: Page[] };

export const home: Page = { label: "Home", source: "site/index.md", route: "" };

const sections: Section[] = [
  {
    title: "Start here",
    nav: "Guide",
    pages: [{ label: "Overview", source: "README.md", route: "guide", sidebarSections: true }],
  },
  {
    title: "Packages",
    nav: "Packages",
    pages: [
      { label: "kv", source: "packages/kv/README.md", route: "kv" },
      { label: "docstore", source: "packages/docstore/README.md", route: "docstore" },
    ],
  },
  {
    title: "Integrations",
    pages: [
      { label: "TanStack DB", source: "packages/tanstack-db/README.md", route: "tanstack-db" },
      { label: "Yjs", source: "packages/yjs/README.md", route: "yjs" },
      { label: "Automerge", source: "packages/automerge/README.md", route: "automerge" },
    ],
  },
  {
    title: "Internals",
    nav: "Internals",
    pages: [
      { label: "Engine design", source: "docs/design.md", route: "internals/design" },
      { label: "Manifest format", source: "docs/manifest-format.md", route: "internals/manifest-format" },
    ],
  },
  {
    title: "Contributing",
    pages: [
      { label: "Set up and release", source: "CONTRIBUTING.md", route: "contributing" },
      { label: "Verify a change", source: "docs/verification.md", route: "contributing/verification" },
    ],
  },
];

export const pages = sections.flatMap((s) => s.pages);
export const everyPage = [home, ...pages];

export const url = (p: Page) => (p.route ? `/${p.route}/` : "/");

const bySource = new Map(everyPage.map((p) => [p.source, p]));
const byUrl = new Map(everyPage.map((p) => [url(p), p]));
export const pageOf = (source: string) => bySource.get(source);
export const pageAt = (siteUrl: string) => byUrl.get(siteUrl);

export const rewrites = Object.fromEntries(
  everyPage.map((p) => [p.source, p.route ? `${p.route}/index.md` : "index.md"]),
);

export const srcExclude = globSync("**/*.md", {
  cwd: repoRoot,
  exclude: (name: string) => name === "node_modules" || name.startsWith("."),
}).filter((f) => !bySource.has(f));

export const nav = sections
  .filter((s) => s.nav)
  .map((s) => ({ text: s.nav, link: url(s.pages[0]) }));

type Heading = { level: number; text: string; slug: string };

export const sidebar = (headingsOf: (source: string) => Heading[]) =>
  sections.map((s) => ({
    text: s.title,
    items: s.pages.map((p) => ({
      text: p.label,
      link: url(p),
      ...(p.sidebarSections && {
        items: headingsOf(p.source)
          .filter((h) => h.level === 2)
          .map((h) => ({ text: h.text, link: `${url(p)}#${h.slug}` })),
      }),
    })),
  }));

const siteDir = `${repoRoot}site`;
const watchedFiles = new Set(everyPage.map((p) => repoRoot + p.source));
const watchedDirs = new Set<string>();
for (const file of watchedFiles) {
  for (let d = dirname(file); d.length >= repoRoot.length - 1; d = dirname(d)) watchedDirs.add(d);
}

export function ignoredByWatcher(path: string): boolean {
  const p = path.split("\\").join("/");
  if (!p.startsWith(repoRoot)) return false;
  if (p === siteDir || p.startsWith(`${siteDir}/`)) return p.startsWith(`${siteDir}/.vitepress/dist`);
  return !watchedFiles.has(p) && !watchedDirs.has(p);
}
