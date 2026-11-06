#!/bin/sh
# R: Resolve an installed Unix Node >=22 for the standard plugin entrypoints.
set -eu
plugin_root=$(CDPATH= cd "${0%/*}/.." && pwd)
usable_node() {
  [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1
}
if [ -n "${THREAD_WATCH_NODE_PATH:-}" ]; then
  if usable_node "$THREAD_WATCH_NODE_PATH"; then
    PATH="${THREAD_WATCH_NODE_PATH%/*}:${PATH:-/usr/bin:/bin}"; export PATH
    exec "$THREAD_WATCH_NODE_PATH" "$@"
  fi
  printf '%s\n' 'thread-watch: THREAD_WATCH_NODE_PATH must select an executable Unix Node >=22.' >&2
  exit 127
fi
node_path=$(command -v node 2>/dev/null || true)
if usable_node "$node_path"; then
  PATH="${node_path%/*}:${PATH:-/usr/bin:/bin}"; export PATH
  exec "$node_path" "$@"
fi
if [ -n "${HOME:-}" ]; then
  for node_path in "$HOME"/.nvm/versions/node/*/bin/node; do
    if usable_node "$node_path"; then
      PATH="${node_path%/*}:${PATH:-/usr/bin:/bin}"; export PATH
      exec "$node_path" "$@"
    fi
  done
fi
printf '%s\n' 'thread-watch: no Unix Node >=22 found on PATH or under HOME/.nvm/versions/node; set THREAD_WATCH_NODE_PATH explicitly.' >&2
exit 127
