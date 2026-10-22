# pi

pi session transcripts are the pi-coding-agent SessionManager JSONL files
written to `~/.pi/agent/sessions/<escaped-cwd>/<timestamp>_<uuid>.jsonl`
(the escaped cwd is the working directory with `/` replaced by `-`): one
`type: "session"` header row carrying the session id, ISO timestamp, and cwd,
followed by `type: "message"` wrapper rows whose `message` holds `user`,
`assistant` (with `text`, `thinking`, and `toolCall` content blocks plus model
metadata), and `toolResult` messages. The whole file is the transcript string.
OpenClaw embeds the same SessionManager, so both adapters share one decoder
(see [`../pi-session-shared.ts`](../pi-session-shared.ts)); the `openclaw`
source additionally masks its `delivery-mirror` placeholder model.

Entries pi puts into the model context without a user/assistant/tool role
(`compaction`, `branch_summary`, `custom_message`, and the `compactionSummary`,
`branchSummary`, `custom`, and `bashExecution` message roles, the last written
for user-typed `!` commands) become user messages carrying the exact text pi's
`convertToLlm` sends; `!!` commands, which pi keeps out of the context, are
skipped, and such an entry with no text is reported as
`injected_context_dropped`. A compaction's retained tail repeats earlier entries
and is not re-emitted. Other lifecycle entries (`model_change`,
`thinking_level_change`, `session_info`, `custom` extension state, `label`)
carry no context and are ignored. Entries are decoded in file
order; a session whose tree was branched in place contributes every recorded
branch, not just the active path. Failed tool results (`isError`) gain an
`Error:` prefix, and malformed JSONL lines are recoverable diagnostics — pi's
own session-file repair drops such lines. Wrapper entry ids provide native
record identity; rows without ids anchor to the append-only byte offset.

## Listing

`listTrajectories({ source: "pi" })` scans `<agentDir>/sessions/*/` for
`.jsonl` transcripts, resolving the agent directory like pi does
(`$PI_CODING_AGENT_DIR`, then `~/.pi/agent`).
