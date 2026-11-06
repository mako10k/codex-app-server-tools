# Installation and updates

## New installation

Requirements: Linux/WSL, Node.js >=22, util-linux `flock`, Codex CLI and an existing App Server with the configured current-user Unix socket. The CLI alone is not that running backend. This package neither launches a shared App Server nor changes authentication. Native Windows/macOS execution has not been validated.

Install the tagged Git marketplace:

```sh
codex plugin marketplace add mako10k/codex-app-server-tools --ref v0.6.13-candidate
codex plugin add thread-watch@codex-app-server-tools
```

Alternatively, from a checked-out repository or extracted package:

```sh
codex plugin marketplace add /absolute/path/to/codex-app-server-tools
codex plugin add thread-watch@codex-app-server-tools
```

Read the installed command's help if the marketplace already exists. Installation/enablement, a chat's loaded MCP connection, and the background controller build are separate observations. Inspect `as_status` and the actual tools/resources catalog. Native display uses `as_monitoring_view`; the optional HTTP viewer is `as_dashboard`. See [viewer details](as-dashboard.md).

## Updating an existing installation

The native installer can remove older version caches of the same plugin. Loaded MCP clients or the running controller may still reference those paths. A running process surviving the install does not mean that its files remain available for later imports or restart.

1. Record the installed cache paths and active frontend/controller versions. Save the current plugin configuration, compatibility decisions and registration JSON files independently of the plugin cache and source directory. Do not copy IPC sockets or replace live state during normal installation.
2. Complete a separate copy of every older cache version still in use **before** starting the installer. Verify the saved files/bytes; do not run the backup and installation concurrently. This example assumes the public marketplace name; use the actual installed path when different:

   ```sh
   plugin_cache="${CODEX_HOME:-$HOME/.codex}/plugins/cache/codex-app-server-tools/thread-watch"
   backup_dir=$(mktemp -d "${TMPDIR:-/tmp}/as-tools-update.XXXXXX")
   cp -a "$plugin_cache" "$backup_dir/cache"
   diff -qr "$plugin_cache" "$backup_dir/cache"
   ```

   Retain this independent copy until the new installation and retained old versions have been read back. The commands above preserve the caches; configuration/state snapshots are the separate copies described in step 1.
3. Run the native plugin installation once. Read its result rather than blindly repeating an uncertain install. Restore any pruned **old version directories** from the verified copy to their original paths, then compare their bytes again. Do not overwrite the newly installed version or consume the only independent backup by moving it back.
4. Verify the new installed package version and files. Confirm that existing configuration and static registration definitions remain unchanged. Installing a package does not migrate registrations, renew heartbeat expiry, unarchive chats or resume goals.
5. Coordinate any required MCP refresh and candidate-controller cutover with affected consumers. MCP reload can temporarily fail calls in other chats; candidate-controller replacement introduces a subscription gap. Use the intended new entrypoint when switching, and read back the controller build, backend identity and connection state. This package does not automatically restart the shared App Server or pinned legacy monitoring.
6. Check the actual consumer's tool/resource catalog and intended read-only path after reconnection. If a rollback is needed, retain the state/receipts, restore the verified old package files and deliberately select the prior entrypoint. An older package is not proof that replaying or rolling back state is valid. Do not reconstruct lost bytes from a newer version and label them an exact original backup.

These are operational update instructions, not new tool permissions, allowlists or runtime gates. Publication, external writes and operational state changes remain within the user's actual authorized task.
