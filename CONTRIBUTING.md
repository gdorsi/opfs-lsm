# Contributing

Before you open a pull request, run `pnpm test` and `pnpm static`.

## Clone and run

`engines.node` in `package.json` is `>=22`. `.nvmrc` pins 24. `packageManager` is `pnpm@10.33.2`.

```sh
git clone https://github.com/gdorsi/opfs-lsm.git
cd opfs-lsm
pnpm install
pnpm test
pnpm bench kv/
```

`pnpm test` typechecks and runs the unit suites. `pnpm bench` runs the benchmarks in headless Chrome: kv against raw IndexedDB, docstore against Dexie, the TanStack DB adapter against TanStack DB's IndexedDB adapter, and the Yjs and Automerge adapters against their IndexedDB counterparts. `pnpm bench:size` prints the bundle sizes. See [bench/README.md](bench/README.md). Set `CHROME_PATH` when Chrome is not on the default macOS path or on `PATH` as `google-chrome`. The formal suite and the Chrome proof helper are in [docs/verification.md](docs/verification.md).

## Figures show what the engine does

A site figure that shows a kv mechanism, such as the WAL, a flush, a broadcast or a read, draws what kv does today. Check the mechanism in `docs/design.md` and `packages/kv/src` before drawing it, and name every simplification in the scene's `REHEARSAL.md`.

## Add a changeset when you change a published package

The repository publishes six packages to npm: `@opfs-lsm/kv`, `@opfs-lsm/docstore`, `@opfs-lsm/tanstack-db`, `@opfs-lsm/tanstack-query`, `@opfs-lsm/yjs`, and `@opfs-lsm/automerge`. [Changesets](https://github.com/changesets/changesets) versions them and writes each package's `CHANGELOG.md`.

If your pull request changes what one of these packages does, add a changeset:

```sh
pnpm changeset
```

The prompt asks which packages changed, the bump type for each, and a summary. It writes a Markdown file to `.changeset/`. Commit that file with your change. The summary becomes the changelog entry, so write it for someone who uses the package.

To skip the prompt, pass the bumps and summary as flags:

```sh
pnpm changeset --patch @opfs-lsm/kv -m "Fix reverse range scans that skipped the last key."
```

Pick the bump type by what a user of the package sees:

- `patch` for a fix that keeps the API the same.
- `minor` for a new feature, and for a breaking change while a package is below 1.0.
- `major` for a breaking change after 1.0.

Changes to tests, benchmarks, examples, or docs need no changeset. The examples and `bench` are private and never publish.

All six packages are fixed to one version, the `fixed` setting in `.changeset/config.json`: a bump to any one of them bumps all of them, so the packages always publish together at the same version and their published dependency ranges always match.

## Release

Releases run locally. On `main` with a clean tree, run:

```sh
pnpm release
```

The script in [scripts/release.ts](scripts/release.ts) (Node runs TypeScript directly; use Node 24 from `.nvmrc`, Node 22 can't run `.ts` without a flag):

1. Checks you are on `main`, the tree is clean, and you are up to date with `origin`.
2. If `.changeset/` has pending files, runs `changeset version`, which deletes them, bumps the versions, and updates each package's `CHANGELOG.md`, then commits the result as `chore(release): version packages`.
3. Runs `pnpm test` and `pnpm static`.
4. Publishes every package whose version is not on npm yet with `changeset publish`, which also tags each published package.
5. Pushes `main` with the tags and opens one GitHub release for the whole run, tagged `v<version>` with the shared version, listing each published package with its changelog entry.

Pass `--dry-run` to print the plan without changing anything, or `--no-github` to skip step 5. npm provenance needs a supported CI environment, so a local publish runs without it.

To see what the next release contains, run:

```sh
pnpm changeset status --verbose
```
