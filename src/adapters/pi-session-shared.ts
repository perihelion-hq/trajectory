/**
 * Shared decoder for pi-coding-agent SessionManager JSONL transcripts: one
 * `type: "session"` header row carrying the session id, ISO timestamp, and
 * cwd, followed by `type: "message"` wrapper rows whose `message` holds
 * `user`, `assistant` (with `text`, `thinking`, and `toolCall` content blocks
 * plus model metadata), and `toolResult` messages. pi writes this format
 * natively; OpenClaw embeds the same SessionManager and adds its own
 * conventions on top.
 *
 * Entries that pi puts into the model context without a user/assistant/tool
 * role (`compaction`, `branch_summary`, `custom_message`, and the
 * `compactionSummary`, `branchSummary`, `custom`, and `bashExecution` message
 * roles) become user messages carrying the exact text pi's `convertToLlm`
 * sends. A `compaction.retainedTail` repeats earlier entries and is not
 * re-emitted. System prompt and tool declarations (`system` messages and
 * `compaction.systemMessage`) are the harness configuration, not session turns,
 * and are deliberately not emitted. `custom` extension state, `usage` rows, and
 * other lifecycle entries carry no context and are ignored. Failed tool results (`isError`) gain an
 * `Error:` prefix, and malformed JSONL lines are recoverable diagnostics — the
 * upstream session-file repair drops such lines. Wrapper entry ids provide
 * native record identity; rows without ids anchor to the append-only byte
 * offset.
 */

import type { DecodedEvent, DecodedSession } from "../internal.js";
import type { Diagnostic, TranscriptTrajectorySource } from "../types.js";
import { NormalizationError } from "../types.js";
import {
  blocksText,
  isObject,
  jsonString,
  parseJsonLines,
  parseTimestamp,
} from "./shared.js";

export interface PiSessionDecodeOptions {
  source: TranscriptTrajectorySource;
  /**
   * Placeholder model identifiers whose prose is kept but which must not
   * contribute model metadata (for example OpenClaw's `delivery-mirror`).
   */
  excludedModels?: readonly string[];
  /** Human-readable source label for the invalid-input error message. */
  sourceLabel: string;
}

export function decodePiSessionTranscript(
  transcript: string,
  options: PiSessionDecodeOptions,
): DecodedSession {
  const diagnostics: Diagnostic[] = [];
  const events: DecodedEvent[] = [];
  const excludedModels = options.excludedModels ?? [];
  let cwd: string | undefined;
  let createdAt: Date | undefined;
  let sessionId: string | undefined;
  let sawMessageRow = false;

  for (const { value: row, line, byteOffset } of parseJsonLines(transcript, diagnostics)) {
    if (row.type === "session") {
      if (!cwd && typeof row.cwd === "string" && row.cwd) cwd = row.cwd;
      createdAt ??= parseTimestamp(row.timestamp);
      if (!sessionId && typeof row.id === "string" && row.id) {
        sessionId = row.id;
      }
      continue;
    }

    const injected = injectedContext(row);
    if (injected !== undefined) {
      sawMessageRow = true;
      const timestamp =
        parseTimestamp(row.timestamp) ??
        (isObject(row.message) ? messageTimestamp(row.message.timestamp) : undefined);
      if (injected) {
        events.push({
          type: "message",
          role: "user",
          content: injected,
          inputLine: line,
          ...(timestamp ? { timestamp } : {}),
          ...(typeof row.id === "string" && row.id
            ? { sourceRecordId: row.id }
            : { sourceOffset: byteOffset, sourceAnchorKind: "byte" }),
          componentIndex: 0,
        });
      } else {
        diagnostics.push({
          code: "injected_context_dropped",
          message: "pi context entry has no text content to preserve",
          inputLine: line,
        });
      }
      continue;
    }
    if (row.type !== "message" || !isObject(row.message)) continue;
    sawMessageRow = true;
    const message = row.message;
    const timestamp =
      parseTimestamp(row.timestamp) ?? messageTimestamp(message.timestamp);
    // Native identity: the wrapper entry id. Rows written before entry ids
    // existed anchor to the append-only byte offset instead (kind `byte`).
    const id = typeof row.id === "string" && row.id ? row.id : undefined;
    const model =
      typeof message.model === "string" &&
      message.model &&
      !excludedModels.includes(message.model)
        ? message.model
        : undefined;
    let componentIndex = 0;
    const emit = (event: DecodedEvent): void => {
      events.push({
        ...event,
        ...(id !== undefined
          ? { sourceRecordId: id }
          : { sourceOffset: byteOffset, sourceAnchorKind: "byte" }),
        componentIndex: componentIndex++,
      });
    };

    if (message.role === "user") {
      const content = blocksText(message.content);
      if (content) {
        emit({
          type: "message",
          role: "user",
          content,
          inputLine: line,
          ...(timestamp ? { timestamp } : {}),
        });
      }
      continue;
    }

    if (message.role === "assistant") {
      if (typeof message.content === "string") {
        if (message.content) {
          emit({
            type: "message",
            role: "assistant",
            content: message.content,
            inputLine: line,
            ...(timestamp ? { timestamp } : {}),
            ...(model ? { model } : {}),
          });
        }
        continue;
      }
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (!isObject(part)) continue;
        if (part.type === "thinking" && typeof part.thinking === "string") {
          emit({
            type: "reasoning",
            content: part.thinking,
            inputLine: line,
            ...(timestamp ? { timestamp } : {}),
            ...(model ? { model } : {}),
          });
        } else if (part.type === "text" && typeof part.text === "string") {
          emit({
            type: "message",
            role: "assistant",
            content: part.text,
            inputLine: line,
            ...(timestamp ? { timestamp } : {}),
            ...(model ? { model } : {}),
          });
        } else if (part.type === "toolCall") {
          emit({
            type: "tool_call",
            args: toolArguments(part.arguments),
            inputLine: line,
            ...(typeof part.id === "string" && part.id ? { id: part.id } : {}),
            ...(typeof part.name === "string" && part.name
              ? { name: part.name }
              : {}),
            ...(timestamp ? { timestamp } : {}),
            ...(model ? { model } : {}),
          });
        }
      }
      continue;
    }

    if (message.role === "toolResult" || message.role === "tool") {
      let content = blocksText(message.content);
      if (message.isError === true && !/^error/i.test(content)) {
        content = `Error: ${content}`;
      }
      emit({
        type: "tool_result",
        content,
        ...(typeof message.isError === "boolean" ? { ok: !message.isError } : {}),
        inputLine: line,
        ...(typeof message.toolCallId === "string" && message.toolCallId
          ? { callId: message.toolCallId }
          : {}),
        ...(timestamp ? { timestamp } : {}),
      });
    }
  }

  if (!sawMessageRow && sessionId === undefined) {
    throw new NormalizationError(
      "invalid_input",
      `${options.sourceLabel} transcript must be session JSONL containing a session header or message entries.`,
    );
  }

  return {
    events,
    context: {
      source: options.source,
      ...(cwd ? { cwd } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(sessionId ? { sourceGroupId: sessionId } : {}),
    },
    diagnostics,
  };
}

// pi-coding-agent `core/messages.js` convertToLlm text (unchanged 0.84.4 to 0.86.0).
const COMPACTION_SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";
const BRANCH_SUMMARY_PREFIX =
  "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
const BRANCH_SUMMARY_SUFFIX = "</summary>";

/**
 * The user-message text pi sends the model for a context entry that has no
 * user/assistant/tool role, `""` when such an entry has no text to preserve,
 * or `undefined` for rows that are not injected context.
 */
function injectedContext(row: Record<string, unknown>): string | undefined {
  if (row.type === "compaction") return summaryText(row.summary, COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX);
  if (row.type === "branch_summary") {
    // pi sends a branch summary only when it is non-empty (sessionEntryToContextMessages).
    return row.summary ? summaryText(row.summary, BRANCH_SUMMARY_PREFIX, BRANCH_SUMMARY_SUFFIX) : undefined;
  }
  if (row.type === "custom_message") return blocksText(row.content);
  if (row.type !== "message" || !isObject(row.message)) return undefined;
  const message = row.message;
  if (message.role === "compactionSummary") return summaryText(message.summary, COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX);
  if (message.role === "branchSummary") return summaryText(message.summary, BRANCH_SUMMARY_PREFIX, BRANCH_SUMMARY_SUFFIX);
  if (message.role === "custom") return blocksText(message.content);
  if (message.role === "bashExecution") {
    // pi's BashExecutionMessage fields; any other shape cannot be rendered as pi rendered it.
    if (!isBashExecution(message)) return "";
    // `!!` commands are excluded from the model context by pi itself.
    return message.excludeFromContext ? undefined : bashExecutionText(message);
  }
  return undefined;
}

function summaryText(summary: unknown, prefix: string, suffix: string): string {
  return typeof summary === "string" ? prefix + summary + suffix : "";
}

interface BashExecution {
  command: string;
  output: string;
  exitCode?: number | null;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
}

function isBashExecution(message: Record<string, unknown>): message is Record<string, unknown> & BashExecution {
  const optional = (value: unknown, type: string): boolean => value === undefined || typeof value === type;
  return (
    typeof message.command === "string" &&
    typeof message.output === "string" &&
    typeof message.cancelled === "boolean" &&
    typeof message.truncated === "boolean" &&
    (message.exitCode === null || optional(message.exitCode, "number")) &&
    optional(message.fullOutputPath, "string") &&
    optional(message.excludeFromContext, "boolean")
  );
}

// pi-coding-agent core/messages.js bashExecutionToText, over validated fields.
function bashExecutionText(message: BashExecution): string {
  let text = `Ran \`${message.command}\`\n`;
  text += message.output ? `\`\`\`\n${message.output}\n\`\`\`` : "(no output)";
  if (message.cancelled) {
    text += "\n\n(command cancelled)";
  } else if (message.exitCode !== null && message.exitCode !== undefined && message.exitCode !== 0) {
    text += `\n\nCommand exited with code ${message.exitCode}`;
  }
  if (message.truncated && message.fullOutputPath) {
    text += `\n\n[Output truncated. Full output: ${message.fullOutputPath}]`;
  }
  return text;
}

/**
 * Wrapper rows carry ISO timestamps; messages can additionally stamp
 * `message.timestamp` with `Date.now()` milliseconds. `parseTimestamp` already
 * treats large numbers as epoch ms.
 */
function messageTimestamp(value: unknown): Date | undefined {
  return parseTimestamp(value);
}

function toolArguments(value: unknown): string {
  if (typeof value === "string" && value) return value;
  return jsonString(value);
}
