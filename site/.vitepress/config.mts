import { createReadStream, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitepress";
import { checkSite, githubSlug, headingsOf, linkRule, outlineOf, unregistered } from "./links.ts";
import { base, github, ignoredByWatcher, nav, pageOf, rewrites, sidebar, srcExclude } from "./pages.ts";

const vitepressRequire = createRequire(import.meta.resolve("vitepress"));

const demoDir = fileURLToPath(new URL("./dist/demo", import.meta.url));
const demoTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
};

/**
 * The live demo on the home page is a second build, emitted into the site's output (`pnpm demo`). The build and the
 * preview find it there. The dev server has no output, so this serves it from the same folder.
 */
const serveDemo: Plugin = {
  name: "opfs-lsm-demo",
  configureServer(server) {
    server.middlewares.use(`${base}demo`, (req, res, next) => {
      const path = normalize(decodeURIComponent((req.url ?? "/").split(/[?#]/)[0]!));
      const file = join(demoDir, path.endsWith("/") ? `${path}index.html` : path);
      if (!file.startsWith(demoDir) || !existsSync(file) || !statSync(file).isFile()) return next();
      res.setHeader("content-type", demoTypes[extname(file)] ?? "application/octet-stream");
      createReadStream(file).pipe(res);
    });
  },
};

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
      plugins: [serveDemo],
      // The illustrations are React components (site/stageshow), mounted by a Vue wrapper.
      esbuild: { jsx: "automatic", jsxImportSource: "react" },
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
