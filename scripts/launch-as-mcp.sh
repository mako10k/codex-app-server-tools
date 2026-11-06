#!/bin/sh
# R: Start the isolated as_ MCP candidate with an installed supported Node runtime.
set -eu
plugin_root=$(CDPATH= cd "${0%/*}/.." && pwd)
exec /bin/sh "$plugin_root/scripts/launch-node.sh" "$plugin_root/bin/as-tools.js" mcp "$@"
