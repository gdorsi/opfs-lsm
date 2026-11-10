# Contributing

To set up the repository and run the tests, follow [Clone and run](README.md#clone-and-run) in the README. Before you open a pull request, run `pnpm test` and `pnpm static`.

## Add a changeset when you change a published package

The repository publishes four packages to npm: `@opfs-lsm/kv`, `@opfs-lsm/collections`, `@opfs-lsm/yjs`, and `@opfs-lsm/automerge`. [Changesets](https://github.com/changesets/changesets) versions them and writes each package's `CHANGELOG.md`.

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
