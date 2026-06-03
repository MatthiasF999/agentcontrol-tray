#!/usr/bin/env bash
# check-release-gates.sh — enforces Phase 37 release gates Add-43 + Add-44.
#
# Add-43: every commit in the PR (origin/main..HEAD) MUST carry the
#   `Co-Authored-By: Claude` trailer. Direct main-pushes (no PR)
#   check only HEAD~1..HEAD (the single newly-pushed commit).
#
# Add-44: NO commit body in origin/main..HEAD may reference a bypass
#   flag (--no-verify, --no-gpg-sign, --remote).
#
# Usage (in a CI workflow):
#   bash scripts/check-release-gates.sh
#
# Exit status:
#   0 — all gates pass
#   1 — at least one gate failed (script prints ::error:: lines)
set -euo pipefail

# Resolve the commit range. On PR events GitHub provides a real merge-base
# via github.event.pull_request.base.sha (passed in as $BASE_SHA), but for
# direct pushes we fall back to HEAD~1..HEAD. The workflow MUST `git fetch
# --depth 0` so origin/main is locally resolvable.
RANGE="${RELEASE_GATE_RANGE:-}"
if [ -z "$RANGE" ]; then
  if git rev-parse --verify --quiet origin/main >/dev/null; then
    if git merge-base --is-ancestor origin/main HEAD 2>/dev/null; then
      RANGE="origin/main..HEAD"
    else
      RANGE="HEAD~1..HEAD"
    fi
  else
    RANGE="HEAD~1..HEAD"
  fi
fi

echo "[release-gates] checking range: $RANGE"

# Collect SHAs in range. `--no-merges` skips GitHub's synthetic merge
# commit on PR builds (which has no Co-Authored-By trailer because it's
# auto-generated, not authored by a human).
mapfile -t SHAS < <(git rev-list --no-merges "$RANGE")
if [ "${#SHAS[@]}" -eq 0 ]; then
  echo "[release-gates] no commits in range; trivially pass."
  exit 0
fi

FAIL=0

# Add-43 — Co-Authored-By trailer per-commit. Case-insensitive because
# Github squash-merge normalises `Co-Authored-By` → `Co-authored-by`.
for sha in "${SHAS[@]}"; do
  body="$(git log -1 --format=%B "$sha")"
  if ! grep -qiE '^Co-Authored-By: Claude' <<<"$body"; then
    short="$(git log -1 --format=%h "$sha")"
    subject="$(git log -1 --format=%s "$sha")"
    echo "::error::Add-43 — commit $short ($subject) missing 'Co-Authored-By: Claude' trailer"
    FAIL=1
  fi
done

# Add-44 — no bypass flags in any commit body.
#
# Self-referential exemption: commits that DOCUMENT the gate (Phase 37
# blueprint, this script, the workflow file) will mention the flag names
# verbatim in their commit body. Such commits opt out by including
# `release-gate-exempt: <reason>` on its own line in the body. The
# exemption is tracked + auditable per commit; it is not a global escape
# hatch.
for sha in "${SHAS[@]}"; do
  body="$(git log -1 --format=%B "$sha")"
  if grep -qiE '^release-gate-exempt:' <<<"$body"; then
    short="$(git log -1 --format=%h "$sha")"
    echo "[release-gates] commit $short exempt via 'release-gate-exempt:' trailer — skipping Add-44 check"
    continue
  fi
  if grep -E -- '(--no-verify|--no-gpg-sign|--remote)\b' <<<"$body" >/dev/null; then
    short="$(git log -1 --format=%h "$sha")"
    subject="$(git log -1 --format=%s "$sha")"
    echo "::error::Add-44 — commit $short ($subject) body references a bypass flag (--no-verify / --no-gpg-sign / --remote). If documenting the gate, add 'release-gate-exempt: <reason>' on its own line."
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo "[release-gates] FAIL — see ::error:: lines above."
  exit 1
fi

echo "[release-gates] OK — ${#SHAS[@]} commit(s) pass Add-43 + Add-44."
