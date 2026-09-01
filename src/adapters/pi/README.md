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

Pi `compaction` entries become `observation` records. Their native id and
timestamp retain identity and time; deterministic JSON content retains the
measured `parentId`, `summary`, `firstKeptEntryId`, `tokensBefore`, `details`,
`usage`, and `fromHook` facts. Non-content setting entries (`model_change` and
`thinking_level_change`) are ignored. Other lifecycle or extension entries
(`session_info`, `branch_summary`, `custom`, `custom_message`, `label`, and
unknown types) produce `noise_record_dropped` diagnostics instead of
disappearing. OpenClaw retains its prior ignore behavior. Message roles other
than `user`/`assistant`/`toolResult` (for example `bashExecution` rows written
for user-typed `!` commands) are skipped. Entries are decoded in file order; a
session whose tree was branched in place contributes every recorded branch,
not just the active path. Failed tool results (`isError`) gain an `Error:`
prefix, and malformed JSONL lines are recoverable diagnostics — pi's own
session-file repair drops such lines. Wrapper entry ids provide native record
identity; rows without ids anchor to the append-only byte offset.

## Listing

`listTrajectories({ source: "pi" })` scans `<agentDir>/sessions/*/` for
`.jsonl` transcripts, resolving the agent directory like pi does
(`$PI_CODING_AGENT_DIR`, then `~/.pi/agent`).
