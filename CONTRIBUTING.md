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
pnpm todo:example
pnpm automerge:example
pnpm rich-text:example
```

`pnpm test` typechecks and runs the unit suites. `pnpm bench` runs the benchmarks in headless Chrome: kv against raw IndexedDB, docstore against Dexie, the TanStack DB adapter against TanStack DB's IndexedDB adapter, and the Yjs, Automerge and fate adapters against their IndexedDB counterparts. `pnpm bench:size` prints the bundle sizes. See [bench/README.md](bench/README.md). Set `CHROME_PATH` when Chrome is not on the default macOS path or on `PATH` as `google-chrome`. The formal suite and the Chrome proof helper are in [docs/verification.md](docs/verification.md).

## Add a changeset when you change a published package

The repository publishes six packages to npm: `@opfs-lsm/kv`, `@opfs-lsm/docstore`, `@opfs-lsm/tanstack-db`, `@opfs-lsm/yjs`, `@opfs-lsm/automerge`, and `@opfs-lsm/fate`. [Changesets](https://github.com/changesets/changesets) versions them and writes each package's `CHANGELOG.md`.

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

When `@opfs-lsm/kv` gets a new version, Changesets also gives a patch bump to the packages that depend on it, so their published dependency range stays correct.

## Release

`.github/workflows/release.yml` runs on every push to `main`. It runs `pnpm test` and `pnpm static`, then hands off to `changesets/action`:

1. If `main` has changeset files, the action opens or updates a pull request named `chore(release): version packages`. That pull request runs `changeset version`, which deletes the changeset files, bumps the versions, and updates each package's `CHANGELOG.md`.
2. To release, merge that pull request.
3. On the push from the merge, `main` has no changeset files left, so the action runs `pnpm changeset publish`. That command publishes every package whose version is not on npm yet, with provenance, and pushes a git tag for each one.

The workflow needs the `NPM_TOKEN` repository secret.

To see what the next release contains, run:

```sh
pnpm changeset status --verbose
```
