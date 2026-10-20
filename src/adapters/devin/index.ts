import type {
  DecodedEvent,
  DecodedSession,
  SourceAdapter,
} from "../../internal.js";
import type { Diagnostic } from "../../types.js";
import { NormalizationError } from "../../types.js";
import {
  isObject,
  jsonString,
  nonemptyString,
  parseJsonLines,
  parseTimestamp,
} from "../shared.js";

/**
 * Fields that carry a process environment. Devin's `exec` tool input includes
 * the session's secrets as `env`, so these are removed at every depth before an
 * argument or result is serialized. Nothing downstream ever sees them.
 */
const ENVIRONMENT_FIELD = /^(env|envs|environment|env_vars|environment_variables)$/i;

/** Devin's tool for the agent's own visible message to the user. */
const USER_MESSAGE_TOOL = "message_user";

/** Lifecycle hooks that carry no model input. */
const LIFECYCLE_EVENTS = new Set([
  "SessionStart",
  "SessionEnd",
  "PermissionRequest",
]);

/**
 * Decode a Devin hook stream: one JSON object per line, each either a Devin
 * command-hook stdin payload or `{ "received_at": RFC3339, "hook": payload }`.
 */
export const devinAdapter: SourceAdapter = {
  source: "devin",

  decode(transcript: string): DecodedSession {
    const diagnostics: Diagnostic[] = [];
    const events: DecodedEvent[] = [];
    const sessionIds = new Set<string>();
    const emittedCalls = new Set<string>();
    const emittedResults = new Set<string>();
    const emittedMessages = new Set<string>();
    let recognized = 0;

    for (const { value: row, line } of parseJsonLines(transcript, diagnostics)) {
      const envelope = isObject(row.hook);
      const hook = envelope ? (row.hook as Record<string, unknown>) : row;
      const eventName = nonemptyString(hook.hook_event_name);
      if (!eventName) {
        diagnostics.push(noise(`Skipped a row without a hook event on line ${line}.`, line));
        continue;
      }
      recognized += 1;
      const sessionId = nonemptyString(hook.session_id);
      if (sessionId) sessionIds.add(sessionId);
      if (sessionIds.size > 1) {
        // Native tool and prompt ids are unique only within a session, so one input is one session.
        throw new NormalizationError(
          "source_group_conflict",
          "Devin input must hold the hook payloads of one session.",
        );
      }
      const timestamp = envelope ? parseTimestamp(row.received_at) : undefined;
      const base = {
        ...(timestamp ? { timestamp } : {}),
        sourceSequence: line - 1,
        inputLine: line,
      };

      if (LIFECYCLE_EVENTS.has(eventName)) continue;

      if (eventName === "UserPromptSubmit") {
        const promptId = nonemptyString(hook.prompt_id);
        const content = typeof hook.prompt === "string" ? hook.prompt : "";
        events.push({
          type: "message",
          role: "user",
          content,
          ...base,
          ...(promptId ? { sourceRecordId: `prompt:${promptId}` } : anchor(line)),
          componentIndex: 0,
        });
        continue;
      }

      if (eventName === "Stop") {
        const content = nonemptyString(hook.last_assistant_message);
        const promptId = nonemptyString(hook.prompt_id);
        if (content) {
          events.push({
            type: "message",
            role: "assistant",
            content,
            ...base,
            ...(promptId ? { sourceRecordId: `stop:${promptId}` } : anchor(line)),
            componentIndex: 0,
          });
        }
        continue;
      }

      if (eventName === "PostCompaction") {
        const summary = nonemptyString(hook.summary);
        const receivedAt = envelope ? nonemptyString(row.received_at) : undefined;
        if (summary) {
          events.push({
            type: "observation",
            content: summary,
            ...base,
            // A capturing hook objectifies each payload alone, where every line is line 1; the
            // arrival time keeps two compactions of one session distinct.
            ...(receivedAt ? { sourceRecordId: `compaction:${receivedAt}` } : anchor(line)),
            componentIndex: 0,
          });
        }
        continue;
      }

      if (eventName !== "PreToolUse" && eventName !== "PostToolUse") {
        diagnostics.push(
          noise(`Skipped unsupported Devin hook ${JSON.stringify(eventName)} on line ${line}.`, line),
        );
        continue;
      }

      const toolName = nonemptyString(hook.tool_name);
      const nativeCallId = nonemptyString(hook.tool_use_id);
      // A payload without tool_use_id cannot pair with another line; its call and result
      // share a deterministic line-local id instead.
      const callId = nativeCallId ?? `devin_line_${line}`;
      if (!nativeCallId && toolName !== USER_MESSAGE_TOOL) {
        diagnostics.push({
          code: "tool_call_id_synthesized",
          message: `Synthesized tool-call ID ${JSON.stringify(callId)} on line ${line}.`,
          inputLine: line,
        });
      }
      const input = withoutEnvironment(hook.tool_input);

      if (toolName === USER_MESSAGE_TOOL) {
        // The agent's visible reply. Its PostToolUse is only the delivery receipt.
        const key = callId;
        const content =
          isObject(input) && typeof input.message === "string" ? input.message : "";
        if (!emittedMessages.has(key) && content) {
          emittedMessages.add(key);
          events.push({
            type: "message",
            role: "assistant",
            content,
            ...base,
            ...(nativeCallId ? { sourceRecordId: nativeCallId } : anchor(line)),
            componentIndex: 0,
          });
        }
        continue;
      }

      // A PostToolUse without its PreToolUse still carries the call's input.
      if (!emittedCalls.has(callId)) {
        emittedCalls.add(callId);
        events.push({
          type: "tool_call",
          args: jsonString(input),
          id: callId,
          ...(toolName ? { name: toolName } : {}),
          ...base,
          ...(nativeCallId ? { sourceRecordId: nativeCallId } : anchor(line)),
          componentIndex: 0,
        });
      }
      if (eventName === "PostToolUse") {
        if (emittedResults.has(callId)) {
          diagnostics.push({
            code: "duplicate_tool_result",
            message: `Dropped a repeated Devin tool result on line ${line}.`,
            inputLine: line,
          });
          continue;
        }
        emittedResults.add(callId);
        const response = withoutEnvironment(hook.tool_response);
        const shell = toolName === "exec" ? shellResult(response) : undefined;
        events.push({
          type: "tool_result",
          content: shell ? shell.content : resultContent(response),
          callId,
          ...(shell
            ? { ok: shell.exitCode === 0 }
            : isObject(response) && typeof response.success === "boolean"
              ? { ok: response.success }
              : {}),
          ...base,
          ...(nativeCallId ? { sourceRecordId: `${nativeCallId}:result` } : anchor(line)),
          componentIndex: 1,
        });
      }
    }

    if (recognized === 0) {
      throw new NormalizationError(
        "invalid_input",
        "Devin transcript must be JSONL of hook payloads with hook_event_name.",
      );
    }
    const sourceGroupId = sessionIds.size === 1 ? [...sessionIds][0]! : undefined;
    return {
      events,
      context: {
        source: "devin",
        ...(sourceGroupId ? { sourceGroupId } : {}),
        ...(sessionIds.size === 0 ? { sourceGroupRequired: true } : {}),
      },
      diagnostics,
    };
  },
};

function anchor(line: number): { sourceOffset: number; sourceAnchorKind: "ordinal" } {
  return { sourceOffset: line - 1, sourceAnchorKind: "ordinal" };
}

function noise(message: string, line: number): Diagnostic {
  return { code: "noise_record_dropped", message, inputLine: line };
}

/** Return a deep copy of a JSON value with every environment field removed. */
export function withoutEnvironment(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutEnvironment);
  if (!isObject(value)) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (ENVIRONMENT_FIELD.test(key)) continue;
    // defineProperty keeps a parsed "__proto__" key an own field instead of invoking its setter.
    Object.defineProperty(copy, key, {
      value: withoutEnvironment(item),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

function resultContent(response: unknown): string {
  if (typeof response === "string") return response;
  if (!isObject(response)) return response === undefined ? "" : jsonString(response);
  const output = typeof response.output === "string" ? response.output : "";
  const error = typeof response.error === "string" ? response.error : "";
  if (output && error) return `${output}\n${error}`;
  return output || error;
}

/**
 * Devin frames an `exec` result as "Output from command in shell <id>:\n<output>\n\n\nExit
 * code: <n>" and reports `success: true` even for a nonzero exit. Unframe the output and take the
 * outcome from the exit code. Any other shape keeps the native fields.
 */
const SHELL_FRAME = /^Output from command in shell [^\s:]+:\n?([\s\S]*?)\n\n\nExit code: (-?\d+)\n?$/;

function shellResult(response: unknown): { content: string; exitCode: number } | undefined {
  if (!isObject(response) || typeof response.output !== "string") return undefined;
  const match = SHELL_FRAME.exec(response.output);
  if (!match) return undefined;
  const error = typeof response.error === "string" ? response.error : "";
  const output = match[1]!;
  return {
    content: output && error ? `${output}\n${error}` : output || error,
    exitCode: Number(match[2]),
  };
}
