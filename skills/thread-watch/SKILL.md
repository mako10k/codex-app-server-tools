---
name: thread-watch
description: Inspect or coordinate chats, goals, lifecycle watches and self-chat heartbeats on the configured existing Codex App Server using as_ tools.
---

## When to use

Use `as_` tools to inspect or coordinate chats on the configured backend, or show monitoring in the Codex right pane. Tool availability does not authorize unrelated work.

## Minimal workflow

1. Inspect relevant state with `as_status` / `as_chat_inspect` and select the intended target.
2. Call the matching tool. For mutations, use the actual runtime `caller_thread_id` and a stable `operation_id`; active input needs the observed `expected_turn_id`.
3. Read back the result. Accepted input is not turn completion. For a notified turn, use its exact `turn_id` in `as_chat_history` and follow continuations.

## Important cautions

- After an uncertain result, inspect the operation receipt before resending.
- Watch changes use the original owner and expected generation. Heartbeats are explicit, expiring self-chat schedules; they do not authorize external polling or Goal changes.
- Goal state and turn execution are separate. Inspect upstream error message/data before diagnosing a refusal.
- Viewing uses `as_monitoring_view`; it does not create registrations. Installation, MCP connection refresh and controller switching are separate operations.

Read only the relevant section of [tool usage](../../docs/tool-usage.md) for detailed contracts. For native/Web display see [viewer details](../../docs/as-dashboard.md); for installation or updates see [installation](../../docs/INSTALL.md).
