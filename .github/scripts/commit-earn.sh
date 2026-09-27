#!/usr/bin/env bash
# Commit docs/earn onto the newest main: snapshot, reset, lay back, push (3 tries).
# The scan job commits docs/iq the same way, so the two never undo each other.
set -u
MSG="$1"
git config user.name  "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
if [[ -z "$(git status --porcelain docs/earn)" ]]; then echo "no changes"; exit 0; fi
SNAP="$RUNNER_TEMP/earn-snapshot"
rm -rf "$SNAP" && mkdir -p "$SNAP/docs" && cp -a docs/earn "$SNAP/docs/earn"
for attempt in 1 2 3; do
  git fetch -q origin main
  git reset -q --hard origin/main
  rm -rf docs/earn && mkdir -p docs && cp -a "$SNAP/docs/earn" docs/earn
  git add -A docs/earn
  if git diff --cached --quiet; then echo "no changes against the newest main"; exit 0; fi
  git commit -q -m "$MSG @ $(date -u +'%Y-%m-%d %H:%M UTC') [actions]"
  if git push -q origin HEAD:main; then echo "pushed on attempt $attempt"; exit 0; fi
  echo "push rejected on attempt $attempt, retrying"; sleep 5
done
echo "could not push after 3 attempts"; exit 1
