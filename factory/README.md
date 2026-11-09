# factory

A daemon that reviews, fixes and merges the owner's pull requests from a spare laptop. Design, rationale and open questions: [docs/research/pr-factory-design.md](../docs/research/pr-factory-design.md).

Read `main.ts` for the loop, `decide.ts` for every decision, `github.ts` for every effect.

## Run

```sh
node factory/main.ts doctor            # checks the setup; add --suite to time the verification suite on main
node factory/main.ts plan [--pr N]     # dry run against the live repo; writes nothing
node factory/main.ts run               # the daemon
node --test 'factory/*.test.ts'        # unit tests, no network
```

## One-time setup

1. Create a GitHub App installed on this repository only. Permissions: contents write, pull requests write, checks write, issues read, metadata read. No workflows, actions or administration. Webhook off. Download its private key.
2. Create two standard macOS users. `factory` runs the daemon and holds the App key at `~factory/.factory/app.pem` (mode 0600). `factoryrun` runs every agent CLI and every check; it holds the model credentials in `~factoryrun/.factory-env` (mode 0600) and no GitHub credential.
3. Add the sudoers line `doctor` prints, so `factory` can run processes as `factoryrun` without a password.
4. As `factoryrun`: install Node 24, pnpm, Rust, Chrome and the agent CLIs; run `claude setup-token` and put the token in `~/.factory-env` as `CLAUDE_CODE_OAUTH_TOKEN=...`; add the reviewer's key (`XAI_API_KEY=...` or the OpenCode key).
5. As `factory`: clone this repository to `~factory/opfs-lsm` at the tag you want the daemon to run, write `~/.factory/config.json` (example in the design doc), run `doctor`, then load a launchd agent that runs `caffeinate -s node factory/main.ts run`.

Start with `"stage": "review"`. Move to `"fix"` and then `"merge"` once the posted reviews and suite results look right.
