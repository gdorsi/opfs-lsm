#!/bin/sh
# SessionStart hook. In the main checkout, tells the agent that other sessions edit it too and how far it is
# behind origin/main. In a linked worktree it prints nothing.
git_dir=$(git rev-parse --absolute-git-dir 2>/dev/null) || exit 0
[ "$git_dir" = "$(git rev-parse --path-format=absolute --git-common-dir)" ] || exit 0

# Fetch so "behind" is current; give up after 8 seconds when offline.
perl -e 'alarm 8; exec @ARGV' git fetch --quiet origin main 2>/dev/null
branch=$(git branch --show-current)
behind=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo "?")
changed=$(git status --porcelain | wc -l | tr -d ' ')

echo "This session started in the main checkout of opfs-async: ${branch:-detached HEAD}, $behind commits behind origin/main, $changed changed paths."
echo "Other sessions edit this checkout at the same time, so these changes may not be yours. Make your changes in a worktree (AGENTS.md, Worktrees)."
if [ "$changed" -gt 0 ]; then git status --short | head -15; fi
exit 0
