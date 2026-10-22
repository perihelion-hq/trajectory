import type {
  AmpExecutionInit,
  ClaudeCodeExecutionStream,
  CodexExecutionStream,
} from "./types.js";
import { NormalizationError } from "./types.js";

type JsonObject = Record<string, unknown>;

/** Codex `exec --json` item types that are tool calls; messages, reasoning and errors are not. */
const CODEX_TOOL_ITEMS = /* @__PURE__ */ new Set([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
  "todo_list",
  "collab_tool_call",
]);
/** Codex states a provider reroute only as an error item's text. */
const CODEX_REROUTE = /model rerouted: (\S+) -> (\S+)/u;
/** Claude Code's per-model counters on its `result` record (SDK `ModelUsage`). */
const CLAUDE_MODEL_USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
] as const;
/** Claude Code's own placeholder model on records no model produced (rate limits, interrupts). */
const CLAUDE_SYNTHETIC_MODEL = "<synthetic>";

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

/**
 * The stream's complete records. A run stopped at its deadline may end mid-record; only that
 * unterminated final fragment is set aside, and every other line must be a JSON object.
 */
function streamRecords(stream: string, owner: string): JsonObject[] {
  const lines = stream.split(/\r?\n/u);
  const tail = lines.at(-1) ?? "";
  if (tail.trim().length > 0) {
    try {
      JSON.parse(tail);
    } catch {
      lines.pop();
    }
  }
  const records: JsonObject[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new NormalizationError("invalid_input", `${owner} line ${index + 1} is not valid JSON.`);
    }
    if (!isObject(record)) {
      throw new NormalizationError("invalid_input", `${owner} line ${index + 1} is not an object.`);
    }
    records.push(record);
  }
  return records;
}

/** A turn's input and output tokens; null when either is absent, and malformed usage throws. */
function codexTurnTokens(usage: unknown): number | null {
  if (usage !== undefined && usage !== null && !isObject(usage)) {
    throw new NormalizationError("invalid_input", "Codex execution stream token usage is invalid.");
  }
  const fields = isObject(usage) ? usage : {};
  let total = 0;
  let reported = true;
  for (const key of ["input_tokens", "output_tokens"]) {
    const value = fields[key];
    if (value === undefined || value === null) {
      reported = false;
      continue;
    }
    const tokens = count(value);
    // Present but malformed usage could otherwise rewrite the total, so it refuses the stream.
    if (tokens === null) {
      throw new NormalizationError("invalid_input", "Codex execution stream token usage is invalid.");
    }
    total += tokens;
  }
  return reported ? total : null;
}

/**
 * Read one Codex `codex exec --json` stream, finished or stopped at its deadline, without making
 * its event wire shape a downstream contract. It is not rollout input, which the Codex adapter
 * owns. The thread identity is an attestation hint, never the caller's identity source.
 */
export function inspectCodexExecStream(stream: string): CodexExecutionStream {
  const threadIds = new Set<string>();
  const reroutedModels: string[] = [];
  const calls = new Set<string>();
  // Per completed call id, whether any completion reported failure; a failure stands.
  const completed = new Map<string, boolean>();
  let tokens = 0;
  // A turn that reports no usage, or never completes, leaves the total unknown, never partial.
  let usageReported = true;
  let turnOpen = false;
  let turnCount = 0;
  let terminalError: string | null = null;
  for (const event of streamRecords(stream, "Codex execution stream")) {
    const kind = event.type;
    if (kind === "thread.started") {
      if (typeof event.thread_id === "string" && event.thread_id.length > 0) {
        threadIds.add(event.thread_id);
      }
    } else if (kind === "turn.started") {
      if (turnOpen) usageReported = false;
      turnOpen = true;
      turnCount += 1;
    } else if (kind === "turn.completed") {
      turnOpen = false;
      const turn = codexTurnTokens(event.usage);
      if (turn === null) usageReported = false;
      else tokens += turn;
    } else if (kind === "turn.failed" || kind === "error") {
      // Each failure event replaces the last: the final one is why the run ended.
      const turnErrorMessage = isObject(event.error) ? event.error.message : undefined;
      const message = kind === "turn.failed" ? turnErrorMessage : event.message;
      terminalError = typeof message === "string" ? message : null;
    } else if (kind === "item.started" || kind === "item.completed") {
      const item = isObject(event.item) ? event.item : {};
      const id = typeof item.id === "string" ? item.id : null;
      if (kind === "item.completed" && item.type === "error" && typeof item.message === "string") {
        const rerouted = CODEX_REROUTE.exec(item.message);
        if (rerouted) reroutedModels.push(rerouted[2]!);
      }
      if (id === null || typeof item.type !== "string" || !CODEX_TOOL_ITEMS.has(item.type)) {
        continue;
      }
      calls.add(id);
      if (kind === "item.completed") {
        const status = item.status;
        const exitCode = item.exit_code;
        const failed =
          (status !== undefined && status !== null && status !== "completed") ||
          (Number.isInteger(exitCode) && exitCode !== 0);
        completed.set(id, (completed.get(id) ?? false) || failed);
      }
    }
  }
  if (turnOpen) usageReported = false;
  if (!Number.isSafeInteger(tokens)) {
    throw new NormalizationError("invalid_input", "Codex execution stream token total is invalid.");
  }
  const ids = (failed: boolean) =>
    [...completed].filter(([, value]) => value === failed).map(([id]) => id).sort();
  return {
    threadId: threadIds.size === 1 ? [...threadIds][0]! : null,
    turnCount,
    reroutedModels,
    toolCallCount: calls.size,
    succeededCallIds: ids(false),
    failedCallIds: ids(true),
    tokenCount: usageReported ? tokens : null,
    terminalError,
  };
}

/**
 * Read one Claude Code `--output-format stream-json` run, finished or stopped at its deadline. Only
 * the main session counts: the session its first `system` `init` record names, without subagent
 * (a non-null `parent_tool_use_id`) or sidechain records. The session identity is an attestation
 * hint, never the caller's identity source.
 */
export function inspectClaudeCodeStream(stream: string): ClaudeCodeExecutionStream {
  const records = streamRecords(stream, "Claude Code execution stream");
  const init = records.find((record) => record.type === "system" && record.subtype === "init");
  const sessionId =
    init && typeof init.session_id === "string" && init.session_id.length > 0
      ? init.session_id
      : null;
  const models = new Set<string>();
  const calls = new Set<string>();
  const succeeded = new Set<string>();
  const failed = new Set<string>();
  let result: JsonObject | null = null;
  for (const record of records) {
    if (
      sessionId === null ||
      record.session_id !== sessionId ||
      (record.parent_tool_use_id !== null && record.parent_tool_use_id !== undefined) ||
      record.isSidechain === true
    ) {
      continue;
    }
    if (record.type === "result") {
      // The last main-session result decides.
      result = record;
      continue;
    }
    if (record.type !== "user" && record.type !== "assistant") continue;
    const message = isObject(record.message) ? record.message : {};
    const blocks = Array.isArray(message.content) ? message.content.filter(isObject) : [];
    if (record.type === "assistant") {
      if (typeof message.model === "string" && message.model !== CLAUDE_SYNTHETIC_MODEL) {
        models.add(message.model);
      }
      for (const block of blocks) {
        if (block.type === "tool_use" && typeof block.id === "string") calls.add(block.id);
      }
    } else {
      for (const block of blocks) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          (block.is_error === true ? failed : succeeded).add(block.tool_use_id);
        }
      }
    }
  }
  let tokenCount: number | null = null;
  const usage = result?.modelUsage;
  if (isObject(usage) && Object.keys(usage).length > 0) {
    // A missing or malformed counter, or an empty `modelUsage` (a crashed run's zeroed result),
    // is unknown.
    const counts = Object.values(usage).flatMap((perModel) =>
      CLAUDE_MODEL_USAGE_KEYS.map((key) => (isObject(perModel) ? count(perModel[key]) : null)),
    );
    if (counts.every((value) => value !== null)) {
      const total = (counts as number[]).reduce((sum, value) => sum + value, 0);
      tokenCount = Number.isSafeInteger(total) ? total : null;
    }
  }
  const errorText = (record: JsonObject): string | null => {
    if (typeof record.result === "string") return record.result;
    const errors = Array.isArray(record.errors) ? record.errors : [];
    const first = errors.find((error) => typeof error === "string");
    return typeof first === "string" ? first : null;
  };
  return {
    sessionId,
    servedModels: [...models],
    toolCallCount: calls.size,
    succeededCallIds: [...succeeded].filter((id) => !failed.has(id)).sort(),
    failedCallIds: [...failed].sort(),
    tokenCount,
    terminalFailure:
      result !== null && result.is_error === true
        ? {
            apiErrorStatus: count(result.api_error_status),
            text: errorText(result),
          }
        : null,
  };
}

/**
 * The MCP servers an Amp --stream-json execution's own `system` `init` record reports, with each
 * one's status; `mcpServers` is null when there is no such record or it names no server list.
 */
export function inspectAmpExecutionInit(stream: string): AmpExecutionInit {
  const init = streamRecords(stream, "Amp execution stream").find(
    (record) => record.type === "system" && record.subtype === "init",
  );
  const servers = init?.mcp_servers;
  return {
    mcpServers: Array.isArray(servers)
      ? servers.filter(isObject).flatMap((server) =>
          typeof server.name === "string"
            ? [{ name: server.name, status: typeof server.status === "string" ? server.status : null }]
            : [],
        )
      : null,
  };
}
