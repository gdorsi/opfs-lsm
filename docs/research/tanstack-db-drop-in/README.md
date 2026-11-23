# TanStack DB drop-in: measurements

The numbers behind [`docs/research/tanstack-db-drop-in.md`](../tanstack-db-drop-in.md). Run both from the repository root after `pnpm install`.

```sh
node docs/research/tanstack-db-drop-in/bundle-parts.mjs
node docs/research/tanstack-db-drop-in/adapter-internals.mjs
```

| Script | Prints |
|---|---|
| `bundle-parts.mjs` | The minified and gzip size of two entries on `@tanstack/db`, split by part of the package, and the size of `packages/tanstack-db/src/plan.ts`. It uses the `@tanstack/db` that `bench` installs and the esbuild that `packages/kv` installs. |
| `adapter-internals.mjs` | For TanStack's Query, Electric and Solid packages: their dependency on `@tanstack/db` and `solid-js`, the values they import from `@tanstack/db`, and how often they use each member of a collection. It downloads the three packages from npm into a temporary folder, at the versions the script names. |

To measure a newer release, raise the `@tanstack/db` version in `bench/package.json` and the versions in `adapter-internals.mjs`.
