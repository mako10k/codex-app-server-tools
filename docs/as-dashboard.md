# Monitoring dashboard

The plugin includes an icon, logo, and a native MCP Apps list for existing watch relationships and heartbeat schedules. It reads saved state and controller status; viewing never starts a monitoring controller or changes registrations.

In Codex, choose **監視・被監視・ハートビート** from the chat UI entrypoints, or call `as_monitoring_view`. The host reads the self-contained `ui://thread-watch/monitoring.html` resource and exchanges snapshots through the MCP Apps bridge. This opens in the right pane without a localhost server or SSH port forwarding. The initial selection is the current chat when the host supplies its thread context. A chat with no registrations still appears in the selector. Choose **すべてのチャット** to inspect all local registrations; refreshing preserves an explicit selection. Counts follow the selected chat.

An already loaded chat can retain an older MCP connection after installation even when the App discovers the new entrypoint. If resource or tool calls go to that older connection, refresh the connection through the host's supported lifecycle. The viewer never performs a global reload itself. Assess other active MCP calls before an operator performs a host-wide reload.

## Optional Web viewer

Use the `as_dashboard` MCP tool, then open its returned `dashboard_url` in a browser. In Codex, a browser panel can display that URL beside the chat when the host provides that entrypoint. Existing MCP connections may need their normal connection refresh to discover the newly installed tool; installing the plugin is not proof that an already loaded connection refreshed. No global MCP reload is performed by the dashboard.

The same bundled viewer can be run directly:

```sh
node bin/as-dashboard.js
```

It prints a localhost URL. `--state DIR` selects an existing candidate state directory. The HTTP server listens on an ephemeral loopback port and provides the viewer and snapshot GET endpoints. There are no registration mutation endpoints. The MCP-started viewer lives with that MCP process; the standalone viewer stops with its process. It creates no operating-system service, monitoring registration, heartbeat or autorun setting.

- **監視:** the observed source, notification destination, registering owner, events and latest delivery result. With a chat selected, show rows where it owns the registration or receives the notification.
- **被監視:** the observed chats, their notification destinations and registering owners. Selecting a chat filters by the observed source.
- **ハートビート:** schedules from every owner in the displayed local registries, including their saved state, start/expiry, cadence, next scheduled time and recent dispatch receipts. Selecting a chat filters by schedule owner or target. Viewing does not reuse the owner-only mutation authority of any schedule.

The inspector separates the candidate registry, the previous App Server monitor and the legacy registry. Missing registries are omitted; failed reads are indicated. A saved definition is shown independently of controller availability and connection state. Expiry is computed for display without rewriting the file. It optionally reads chat names from the local state database in read-only mode and falls back to IDs if names are unavailable. Registration messages are rendered as text, never executable HTML.

Use **更新** to fetch a fresh snapshot; viewing does not start periodic background polling. Chat selection and tabs only change the displayed view. No new permission list, approval prerequisite or automatic hold is introduced.

Package assets are declared through `interface.composerIcon`, `logo` and brand colors, including dark-theme variants. The bundled SVG masters are editable; PNG exports are supplied for host display.

The live screenshots and host-specific inspection records are local verification artifacts, not public example data. Native MCP resource display was verified in one installed Codex Desktop host. Other hosts and versions, and native icon visibility, require their own checks.
