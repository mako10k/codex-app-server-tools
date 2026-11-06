# Codex App Server Tools

Local MCP tools for inspecting and coordinating chats on an existing Codex App Server through the official Proxy. Candidate release: **0.6.12-candidate**, MIT licensed.

This is a Codex plugin, not an npm publication. It requires Linux/WSL, Node.js >=22, util-linux flock, the Codex CLI and an already running App Server exposing the configured current-user Unix socket. Native Windows and macOS have not been validated. No additional npm packages are required, and Codex/Node binaries are not redistributed.

## Tools

- Chat: list, inspect, send, manage, progress, history.
- Goal: get, set, pause, resume, clear.
- Watch: set, list, remove; termination, compaction, goal and prompt events.
- Heartbeat: set, list, remove; expiring self-chat schedules.
- Local management: status, control.
- Downstream MCP: inspect, call.
- Native view: as_monitoring_view; optional Web view: as_dashboard.

The MCP inventory contains 25 tools: 23 `as_` tools and 2 legacy aliases. Tools use the `as_` prefix. Legacy MCP names `watch_thread` and `list_thread_watchers` are compatibility aliases. The previous Hook CLI, local supervisor scripts and personal operations records are not part of this distribution.

The Plugin adds no capability grants, thread/cwd access policy or downstream Tool allowlist. Use tools within the actual user's instructions and existing platform permissions. App Server sandbox, approvals and authentication still apply. Mutating calls use actual runtime caller/turn metadata and an operation ID. An accepted API request is not proof that the destination turn completed. Inspect receipts/history after an uncertain outcome rather than resending it blindly.

## Install

Install the tagged Git marketplace:

```sh
codex plugin marketplace add mako10k/codex-app-server-tools --ref v0.6.12-candidate
codex plugin add thread-watch@codex-app-server-tools
```

Or install from a downloaded/extracted directory

Register this repository/extracted directory as a local marketplace, then install the plugin:

```sh
codex plugin marketplace add /absolute/path/to/codex-app-server-tools
codex plugin add thread-watch@codex-app-server-tools
```

Repository and releases: [mako10k/codex-app-server-tools](https://github.com/mako10k/codex-app-server-tools). Existing chats may retain an older loaded MCP connection after installation; inspect the actual chat connection separately. Updating an active candidate controller may briefly interrupt its watch subscriptions. For existing installations, follow the [update and cache preservation procedure](docs/INSTALL.md#updating-an-existing-installation): native installation can prune older version caches that loaded chats still reference. Complete and verify the independent backup before installing; preserve registration state and coordinate the switching time for active consumers. This package does not automatically restart the shared App Server or migrate old registrations.

## Run and configure

```sh
node bin/as-tools.js --help
sh scripts/launch-as-mcp.sh
```

By default the configured socket is `$CODEX_HOME/app-server-control/app-server-control.sock` (CODEX_HOME defaults to `~/.codex`). The controller state is `~/.local/state/app-server-tools-candidate`. Optional `AS_TOOLS_CONFIG` supplies transport/backend settings such as socket_path, expected_codex_home and proxy_executable. Legacy permission/caller-policy fields are ignored, retained only for existing configuration-binding compatibility.

The compiled protocol baseline is 0.166.0. CLI/server exact pairs 0.166.0/0.166.0 and 0.167.0/0.167.0 have shipped defaults. Unknown pairs start degraded: local status/control remains available, backend operations require an explicit compatibility decision. `as_status` shows observed versions; `as_control` can record compatible/unknown/incompatible decisions and evidence using the current settings digest. See [compatibility evidence](docs/as-compatibility-smoke-2026-11-06.md).

Heartbeat uses starts_at/expires_at with explicit timezone offsets and checks containing check_id/interval_seconds (60..86400). No heartbeat permission, catalog or worktime configuration is required. A check_id supplies its display label when no optional catalog metadata exists. No external mail/issue/calendar polling is performed by the scheduler. The receiving chat follows its own agreed workflow. A paused goal does not block heartbeat input; heartbeat does not change that goal. Busy targets can delay dispatch; missed slots are not blindly replayed.

## Validation and limits

The private development source passed 153 tests. The installed code also passed an isolated official-Proxy heartbeat set/list/first-timer-delivery and body-readback check with no capability/catalog/worktime profile. Production write paths and every host/version have not been validated. This public extraction receives separate clean-install/discovery checks; their result is recorded alongside the preparation artifact.

API schema: [tool-schema.json](docs/tool-schema.json). Operational credentials, real thread IDs, machine-specific paths, daemon state, logs, development history and work-in-progress design documents are excluded. [MIT license](LICENSE).

## Native monitoring view

Select the chat UI entry **監視・被監視・ハートビート**, or call `as_monitoring_view`, to show the monitoring, monitored-chat and heartbeat lists in the Codex right pane. The self-contained `ui://thread-watch/monitoring.html` resource uses the MCP Apps bridge; it needs no localhost HTTP listener or SSH port forwarding. Initial selection uses the current chat when the host provides its runtime thread metadata. Switch to all chats or another chat as needed; refresh preserves the selection. Viewing reads existing snapshots/status and creates no watch, heartbeat, subscription or controller.

The corresponding Codex App consumer was visually verified for the native list and current-chat initial selection. This does not establish support for every host/version. Installing a new plugin version does not guarantee that an existing chat connection refreshed: verify the connected version and tool/resource catalog. Any needed MCP reload is a separate explicit operational action whose effect on other chats must be considered.

`as_dashboard` remains an optional Web viewer; open its `dashboard_url` in a browser. That HTTP route may need localhost forwarding for remote SSH. The Web viewer ends with its MCP process. Standalone: `node bin/as-dashboard.js` (optional `--state DIR`). See [viewer details](docs/as-dashboard.md).

The bundled logo is a 512×512 square SVG/PNG mark; composer icons remain 128×128. Asset references and dimensions were verified. A fresh plugin-list screenshot showing the new logo has not been verified.

Version 0.6.8 and later preserve upstream error message and present data in `details.rpc_message` / `details.rpc_data`. Numeric error codes alone do not identify the refusal reason.
