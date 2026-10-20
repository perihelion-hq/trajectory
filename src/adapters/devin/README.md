# devin

The adapter accepts a stream of Devin command-hook payloads, one JSON object per
line, in arrival order. Devin passes each payload to a command hook on stdin
(`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`,
`SessionEnd`, `PermissionRequest`, `PostCompaction`). Devin sessions expose no
transcript file or export, so the capturing hook is the only native artifact.

A line is either the bare stdin payload or an envelope that adds the arrival
time, which Devin's payloads do not carry:

```json
{ "received_at": "2026-10-20T16:30:02.000Z", "hook": { "hook_event_name": "PreToolUse", "...": "..." } }
```

Decoding:

- `UserPromptSubmit.prompt` becomes a user message, identified by `prompt_id`.
- `PreToolUse` becomes a tool call identified by `tool_use_id`; the matching
  `PostToolUse` becomes its result. `tool_response` is
  `{ success, output, error }`: `output` (and `error`, when present) is the
  result text and `success` is the source-native `ok`. A shell call (`exec`)
  reports `success: true` even when the command exits non-zero, and frames its
  output as `Output from command in shell <id>:\n<output>\n\n\nExit code: <n>`.
  For `exec`, the adapter unframes the output and sets `ok` to `n == 0`. An
  `exec` output in any other shape keeps the native fields.
- A `PostToolUse` with no earlier `PreToolUse` for the same `tool_use_id` emits
  the call from its own `tool_input`, so a single `PostToolUse` objectified on
  its own yields the same call and result records as the whole stream.
- `message_user` is the agent's visible reply. Its `tool_input.message` becomes
  an assistant message; its `PostToolUse` is only the delivery receipt.
- `Stop.last_assistant_message`, when non-empty, becomes an assistant message.
  `PostCompaction.summary` becomes an observation.
- `SessionStart`, `SessionEnd` and `PermissionRequest` carry no model input and
  are skipped. Other hook names and rows without `hook_event_name` are
  recoverable `noise_record_dropped` diagnostics.

Environment fields are removed at decode, at every depth of `tool_input` and
`tool_response`, before any argument or result is serialized: keys named `env`,
`envs`, `environment`, `env_vars` or `environment_variables`, case-insensitive.
Devin's `exec` tool input carries the session's secrets in `env`; no output of
this library contains those environment fields. Secret text inside command
output or other hook text is not removed here; that is the caller's redaction.

Every payload carries `session_id`, which is the canonical source group. Devin
payloads carry no model identity. A payload without `tool_use_id` gets a
line-local synthesized id (`tool_call_id_synthesized`). Listing is not supported:
there is no local store to discover.

Callers that objectify each payload as it arrives pass
`sourceContext.partial: true`; identities come from `tool_use_id`,
`prompt_id` and, for `PostCompaction`, the envelope's `received_at`, not from
line position. A payload missing those ids falls back to a line-local anchor,
which is stable only for whole-stream input.
