import { createRequire } from "node:module";
import { defineConfig } from "vitepress";
import { checkSite, githubSlug, headingsOf, linkRule, outlineOf, unregistered } from "./links.ts";
import { base, github, ignoredByWatcher, nav, pageOf, rewrites, sidebar, srcExclude } from "./pages.ts";

const vitepressRequire = createRequire(import.meta.resolve("vitepress"));

export default ({ command }: { command: string }) => {
  checkSite();
  return defineConfig({
    title: "opfs-lsm",
    description: "A key-value store for the browser, on OPFS and IndexedDB.",
    base,
    srcDir: "..",
    srcExclude,
    rewrites,
    vite: {
      optimizeDeps: { entries: [] },
      server: { watch: { ignored: [ignoredByWatcher] } },
      resolve: {
        alias: [
          { find: /^vue$/, replacement: vitepressRequire.resolve("vue/dist/vue.runtime.esm-bundler.js") },
          { find: /^vue\/server-renderer$/, replacement: vitepressRequire.resolve("vue/server-renderer") },
        ],
      },
    },
    markdown: {
      anchor: { slugify: githubSlug },
      config: linkRule(command === "build"),
    },
    transformPageData(page) {
      if (pageOf(page.filePath)?.route) page.frontmatter.outline ??= outlineOf(page.filePath);
    },
    buildEnd(site) {
      unregistered(site.pages);
    },
    themeConfig: {
      nav,
      sidebar: sidebar(headingsOf),
      search: { provider: "local" },
      editLink: { pattern: `${github}/edit/main/:path`, text: "Edit this page on GitHub" },
      socialLinks: [{ icon: "github", link: github }],
    },
  });
};
