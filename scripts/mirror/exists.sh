#!/usr/bin/env bash
# Does `<remote:dir>` hold a file called `<name>`? Prints `yes` or `no`, and fails on any
# other outcome, so a step written as `present=$(exists.sh …)` under `set -e` stops on an
# error instead of reading it as "absent".
#
#   scripts/mirror/exists.sh mirror:unbent-mirror/state prune.json
#
# Two things made `rclone lsf … | grep -q name` wrong for this. On S3, a prefix with
# nothing under it is not a directory to rclone, which exits 3 ("directory not found")
# rather than printing nothing (the first night's `state/` and `status/` are exactly that),
# so the error had to be silenced, and silencing it silenced a refused credential too,
# which read as "absent" and would have restarted every prune clock. And `grep -q` exits on
# its first match, so a listing with a later line can die of SIGPIPE, which under
# `pipefail` turns a present file into a missing one. The listing is read whole here, and
# only exit 3 is "no".
set -euo pipefail

dir="$1"
name="$2"

set +e
listing="$(rclone lsf --files-only "$dir" 2>&1)"
status=$?
set -e

case "$status" in
  0) ;;
  3)
    echo no
    exit 0
    ;;
  *)
    printf '%s\n' "$listing" >&2
    echo "rclone lsf $dir failed with exit $status" >&2
    exit "$status"
    ;;
esac

if printf '%s\n' "$listing" | grep -Fx -- "$name" > /dev/null; then
  echo yes
else
  echo no
fi
