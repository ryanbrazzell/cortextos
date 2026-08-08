#!/usr/bin/env bash
# link-worktree-deps.sh — point a git worktree's node_modules at the primary checkout's
#
# Run from inside a worktree:
#   bash scripts/link-worktree-deps.sh
#
# `git worktree add` creates a checkout with no node_modules at all. `npm test`
# is a single vitest run spanning the root suite AND dashboard/, so a worktree
# needs BOTH trees before the suite means anything. Installing them per worktree
# costs minutes and disk; symlinking the primary checkout's costs nothing.
#
# The dashboard tree is the one that gets forgotten — linking only the root tree
# still leaves 12 files unable to resolve 'next/server' and 'better-sqlite3',
# which reads as broken tests rather than a missing install.

set -euo pipefail

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "Error: must be run from inside a git worktree." >&2
  exit 1
}

# Ask git which worktree is the main one rather than inferring it from where
# .git sits. `dirname "$(git rev-parse --git-common-dir)"` only holds for a
# conventional clone whose common dir is <primary>/.git; with --separate-git-dir,
# a bare repo, or a relocated gitdir it silently names an unrelated directory and
# we would link dependencies in from somewhere arbitrary. In
# `git worktree list --porcelain` the first record is always the main worktree.
PRIMARY="$(git worktree list --porcelain | awk '/^worktree /{print substr($0,10); exit}')"
HERE="$(git rev-parse --show-toplevel)"

if [[ -z "$PRIMARY" ]]; then
  echo "Error: could not determine the main worktree." >&2
  exit 1
fi

if [[ "$HERE" == "$PRIMARY" ]]; then
  echo "This IS the primary checkout ($PRIMARY) — nothing to link."
  echo "Install directly instead:  npm ci && npm ci --prefix dashboard"
  exit 0
fi

link_tree() {
  local rel="$1"                      # "" for root, "dashboard" for the dashboard tree
  local src="$PRIMARY${rel:+/$rel}/node_modules"
  local dest="$HERE${rel:+/$rel}/node_modules"
  local label="${rel:-root}"

  if [[ ! -d "$src" ]]; then
    echo "  Skipped $label: nothing to link from ($src does not exist)." >&2
    echo "           Install it in the primary checkout first." >&2
    return 1
  fi

  if [[ -L "$dest" ]]; then
    # An existing link may be a deliberate pointer at some other dependency
    # cache. Overwriting it would destroy that configuration silently, so only
    # refresh a link that already points where we would point it, and otherwise
    # report and change nothing.
    local current
    current="$(readlink "$dest")"
    if [[ "$current" == "$src" ]]; then
      echo "  Already linked $label -> $src"
      return 0
    fi
    echo "  Skipped $label: $dest already points elsewhere ($current)." >&2
    echo "           Remove it yourself if you want it repointed at $src." >&2
    return 1
  fi

  if [[ -e "$dest" ]]; then
    echo "  Skipped $label: $dest is a real directory, leaving it in place."
    return 0
  fi

  # Check ln's own status. Inside a function invoked as `link_tree ... || rc=1`,
  # errexit is suppressed for the whole call, so a failing ln would otherwise
  # fall through to the success message and report a link that does not exist.
  if ! ln -s "$src" "$dest"; then
    echo "  Failed to link $label: ln returned an error." >&2
    return 1
  fi
  # Verify the result rather than trusting the exit code alone.
  if [[ ! -d "$dest" ]]; then
    echo "  Failed to link $label: $dest is not usable after linking." >&2
    return 1
  fi
  echo "  Linked $label -> $src"
}

echo "Linking worktree dependencies from $PRIMARY ..."
rc=0
link_tree "" || rc=1
link_tree dashboard || rc=1

if [[ $rc -ne 0 ]]; then
  echo "Done with warnings — at least one tree could not be linked." >&2
  exit 1
fi

echo "Done. Both dependency trees are available; the suite can run here."
echo
# A gitignore pattern written as `node_modules/` matches a directory but NOT a
# symlink to one, so these links surface as untracked in `git status`. Worth
# saying out loud: the failure mode is committing them via a reflexive add-all.
echo "Note: these symlinks show as untracked in 'git status' (a 'node_modules/'"
echo "      ignore pattern does not match a symlink). Stage paths explicitly —"
echo "      'git add -A' here would commit the links."
