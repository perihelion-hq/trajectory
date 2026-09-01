/**
 * Shared decoder for pi-coding-agent SessionManager JSONL transcripts: one
 * `type: "session"` header row carrying the session id, ISO timestamp, and
 * cwd, followed by `type: "message"` wrapper rows whose `message` holds
 * `user`, `assistant` (with `text`, `thinking`, and `toolCall` content blocks
 * plus model metadata), and `toolResult` messages. pi writes this format
 * natively; OpenClaw embeds the same SessionManager and adds its own
 * conventions on top.
 *
 * Pi compaction entries become observations with every measured source fact
 * retained as deterministic JSON. OpenClaw and non-content setting entries
 * retain their prior behavior; unsupported Pi lifecycle entries become loss
 * diagnostics instead of disappearing. Failed tool results (`isError`) gain
 * an `Error:` prefix, and malformed JSONL lines are recoverable diagnostics —
 * the upstream session-file repair drops such lines. Wrapper entry ids provide
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

const PI_COMPACTION_KEYS = [
  "details",
  "firstKeptEntryId",
  "fromHook",
  "id",
  "parentId",
  "summary",
  "timestamp",
  "tokensBefore",
  "type",
  "usage",
] as const;
const PI_SETTING_ENTRY_TYPES = new Set(["model_change", "thinking_level_change"]);

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

    if (options.source === "pi" && row.type === "compaction") {
      const timestamp = parseTimestamp(row.timestamp);
      if (!isPiCompaction(row) || !timestamp) {
        diagnostics.push({
          code: "noise_record_dropped",
          message: `Dropped malformed Pi compaction entry on line ${line}.`,
          inputLine: line,
        });
        continue;
      }
      events.push({
        type: "observation",
        content: jsonString({
          parentId: row.parentId,
          summary: row.summary,
          firstKeptEntryId: row.firstKeptEntryId,
          tokensBefore: row.tokensBefore,
          details: row.details,
          usage: row.usage,
          fromHook: row.fromHook,
        }),
        inputLine: line,
        sourceRecordId: row.id,
        componentIndex: 0,
        timestamp,
      });
      continue;
    }

    if (row.type !== "message" || !isObject(row.message)) {
      if (
        options.source === "pi" &&
        (typeof row.type !== "string" || !PI_SETTING_ENTRY_TYPES.has(row.type))
      ) {
        diagnostics.push({
          code: "noise_record_dropped",
          message: `Dropped unsupported Pi lifecycle entry on line ${line}.`,
          inputLine: line,
        });
      }
      continue;
    }
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

function isPiCompaction(row: Record<string, unknown>): row is Record<string, unknown> & {
  details: Record<string, unknown>;
  firstKeptEntryId: string;
  fromHook: boolean;
  id: string;
  parentId: string;
  summary: string;
  timestamp: string;
  tokensBefore: number;
  type: "compaction";
  usage: Record<string, unknown>;
} {
  return (
    Object.keys(row).sort().join("\u0000") === PI_COMPACTION_KEYS.join("\u0000") &&
    typeof row.id === "string" &&
    row.id.length > 0 &&
    typeof row.parentId === "string" &&
    row.parentId.length > 0 &&
    typeof row.timestamp === "string" &&
    typeof row.summary === "string" &&
    typeof row.firstKeptEntryId === "string" &&
    row.firstKeptEntryId.length > 0 &&
    Number.isSafeInteger(row.tokensBefore) &&
    Number(row.tokensBefore) >= 0 &&
    isObject(row.details) &&
    isObject(row.usage) &&
    typeof row.fromHook === "boolean"
  );
}
