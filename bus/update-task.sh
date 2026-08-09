#!/usr/bin/env bash
# update-task.sh — wrapper for Node.js CLI
# Usage: update-task.sh <id> <status> [note] [blocked_by]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"

ID="${1:-}"
STATUS="${2:-}"
# `${3-}` not `${3:-}`: the former distinguishes "not passed" from
# "passed as empty", and an empty blocked_by is a real instruction
# (clear the list) that a :- default would silently swallow.
NOTE="${3-}"
BLOCKED_BY="${4-}"

if [[ -z "$ID" || -z "$STATUS" ]]; then
  echo "Usage: update-task.sh <id> <status> [note] [blocked_by]" >&2
  exit 1
fi

# This wrapper used to accept [note] and [blocked_by] in its usage line
# and then exec without them, so a caller supplying a blocker got exit 0
# and no dependency — the invisible-blocker bug. blocked_by now forwards
# to the real flag; note has no CLI equivalent, so say so instead of
# dropping it on the floor.
if [[ -n "$NOTE" ]]; then
  echo "update-task.sh: note argument is not supported by the CLI and was ignored" >&2
fi

if [[ $# -ge 4 ]]; then
  exec node "$CLI" bus update-task "$ID" "$STATUS" --blocked-by "$BLOCKED_BY"
fi

exec node "$CLI" bus update-task "$ID" "$STATUS"
