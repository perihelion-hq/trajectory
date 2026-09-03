import { atifAdapter } from "./adapters/atif/index.js";
import { ampAdapter } from "./adapters/amp/index.js";
import { claudeCodeAdapter } from "./adapters/claude-code/index.js";
import { codexAdapter } from "./adapters/codex/index.js";
import { copilotCliAdapter } from "./adapters/copilot-cli/index.js";
import { cursorAdapter } from "./adapters/cursor/index.js";
import { droidAdapter } from "./adapters/droid/index.js";
import { geminiCliAdapter } from "./adapters/gemini-cli/index.js";
import { hermesAdapter } from "./adapters/hermes/index.js";
import { lettaCodeAdapter } from "./adapters/letta-code/index.js";
import { openClawAdapter } from "./adapters/openclaw/index.js";
import { openHandsAdapter } from "./adapters/openhands/index.js";
import { openCodeAdapter } from "./adapters/opencode/index.js";
import { ompAdapter } from "./adapters/omp/index.js";
import { piAdapter } from "./adapters/pi/index.js";
import type { ResolvedNormalizationBounds } from "./bounds.js";
import { resolveBounds } from "./bounds.js";
import type { ResolvedNormalizationFilters } from "./filters.js";
import { resolveFilters } from "./filters.js";
import { finalizeCanonical, GROUP_SENTINEL } from "./canonical.js";
import {
  normalizeDecodedSession,
  normalizeDecodedSessionInternal,
} from "./core.js";
import type { DecodedSession, SourceAdapter } from "./internal.js";
import type {
  AmpExecutionIdentity,
  AmpExecutionStream,
  AmpModelAttestation,
  CanonicalResult,
  NormalizeInput,
  NormalizeResult,
  TranscriptTrajectorySource,
} from "./types.js";
import { NormalizationError } from "./types.js";

const ADAPTERS: Record<TranscriptTrajectorySource, SourceAdapter> = {
  atif: atifAdapter,
  amp: ampAdapter,
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  "copilot-cli": copilotCliAdapter,
  cursor: cursorAdapter,
  droid: droidAdapter,
  "gemini-cli": geminiCliAdapter,
  hermes: hermesAdapter,
  "letta-code": lettaCodeAdapter,
  openclaw: openClawAdapter,
  opencode: openCodeAdapter,
  openhands: openHandsAdapter,
  pi: piAdapter,
  omp: ompAdapter,
};

function decodeTranscript(input: NormalizeInput): {
  decoded: DecodedSession;
  bounds: ResolvedNormalizationBounds;
  filters: ResolvedNormalizationFilters;
} {
  if (!input || typeof input !== "object") {
    throw new NormalizationError("invalid_input", "Input must be an object.");
  }
  if (typeof input.transcript !== "string") {
    throw new NormalizationError(
      "invalid_input",
      "Input transcript must be a string containing the source transcript.",
    );
  }

  const adapter = ADAPTERS[input.source];
  if (!adapter) {
    throw new NormalizationError(
      "unknown_source",
      `Unknown trajectory source ${JSON.stringify(input.source)}. Supported sources: ${Object.keys(ADAPTERS).join(", ")}.`,
    );
  }

  return {
    decoded: adapter.decode(input.transcript),
    bounds: resolveBounds(input.bounds),
    filters: resolveFilters(input.filters),
  };
}

export function normalizeTranscript(input: NormalizeInput): NormalizeResult {
  const { decoded, bounds, filters } = decodeTranscript(input);
  return normalizeDecodedSession(decoded, bounds, {
    partial: isPartialTranscript(input),
    filters,
  });
}

/**
 * Inspect one complete Amp thread export for vendor-observed assistant models.
 * The Amp adapter remains the sole owner of export parsing and completeness.
 */
export function inspectAmpModelAttestation(transcript: string): AmpModelAttestation {
  const decoded = ampAdapter.decode(transcript);
  const observations = decoded.assistantModelObservations ?? [];
  const servedModels = [
    ...new Set(
      observations
        .map((observation) => observation.model)
        .filter((model): model is string => model !== undefined),
    ),
  ].sort();
  return {
    assistantMessageCount: observations.length,
    attestedMessageCount: observations.filter(
      (observation) => observation.model !== undefined,
    ).length,
    servedModels,
    complete: !decoded.diagnostics.some(
      (diagnostic) => diagnostic.code === "incomplete_transcript",
    ),
    diagnostics: decoded.diagnostics,
  };
}

/**
 * Recover only an unambiguous Amp thread identity from a possibly incomplete
 * --stream-json result so the process owner can clean up work it just created.
 */
export function inspectAmpExecutionIdentity(stream: string): AmpExecutionIdentity {
  const threadIds = new Set<string>();
  for (const line of stream.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const threadId = (record as Record<string, unknown>).session_id;
    if (typeof threadId === "string" && threadId.length > 0) threadIds.add(threadId);
  }
  return { threadId: threadIds.size === 1 ? [...threadIds][0]! : null };
}

/**
 * Interpret one complete Amp --stream-json execution without making its
 * Claude-compatible wire shape a downstream Roster contract.
 */
export function inspectAmpExecutionStream(stream: string): AmpExecutionStream {
  const threadIds = new Set<string>();
  let terminal: Record<string, unknown> | undefined;
  let toolCallCount = 0;
  const lines = stream.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new NormalizationError("invalid_input", "Amp execution stream is empty.");
  }
  for (let index = 0; index < lines.length; index += 1) {
    let record: unknown;
    try {
      record = JSON.parse(lines[index]!);
    } catch {
      throw new NormalizationError(
        "invalid_input",
        `Amp execution stream line ${index + 1} is not valid JSON.`,
      );
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new NormalizationError(
        "invalid_input",
        `Amp execution stream line ${index + 1} is not an object.`,
      );
    }
    const item = record as Record<string, unknown>;
    if (typeof item.session_id === "string" && item.session_id.length > 0) {
      threadIds.add(item.session_id);
    }
    if (item.type === "assistant") {
      const message = item.message;
      if (message && typeof message === "object" && !Array.isArray(message)) {
        const content = (message as Record<string, unknown>).content;
        if (Array.isArray(content)) {
          toolCallCount += content.filter(
            (block) =>
              block !== null &&
              typeof block === "object" &&
              !Array.isArray(block) &&
              (block as Record<string, unknown>).type === "tool_use",
          ).length;
        }
      }
    }
    if (item.type === "result") {
      if (terminal !== undefined) {
        throw new NormalizationError(
          "invalid_input",
          "Amp execution stream contains multiple terminal results.",
        );
      }
      terminal = item;
    }
  }
  if (threadIds.size !== 1 || terminal === undefined) {
    throw new NormalizationError(
      "invalid_input",
      "Amp execution stream must contain one thread identity and one terminal result.",
    );
  }
  const usage = terminal.usage;
  const inputTokens = safeTokenCount(usage, "input_tokens");
  const outputTokens = safeTokenCount(usage, "output_tokens");
  return {
    threadId: [...threadIds][0]!,
    successful: terminal.is_error === false && terminal.subtype === "success",
    tokenCount: inputTokens + outputTokens,
    toolCallCount,
  };
}

function safeTokenCount(value: unknown, member: string): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const count = (value as Record<string, unknown>)[member];
  if (count === undefined) return 0;
  if (!Number.isSafeInteger(count) || (count as number) < 0) {
    throw new NormalizationError(
      "invalid_input",
      `Amp execution terminal usage.${member} is invalid.`,
    );
  }
  return count as number;
}

/**
 * Normalize a transcript into canonical, ingestion-ready records for the Cloud
 * normalizer worker. The trajectory-v1 output of {@link normalizeTranscript} is
 * unchanged; this is an additive, richer view carrying source-native identity,
 * ordering, and hashing metadata. See CANONICAL.md for the field contract.
 */
export function normalizeToCanonical(input: NormalizeInput): CanonicalResult {
  const { decoded, bounds, filters } = decodeTranscript(input);
  const baseByteOffset = input.sourceContext?.baseByteOffset ?? 0;
  // Partial (chunk) semantics are an explicit signal, decoupled from the byte
  // offset: a non-zero offset always implies a continuation, but an initial chunk
  // at offset 0 can also be partial. Meta emission tracks the byte offset only,
  // so an offset-0 partial still emits the authoritative meta.
  const partial = isPartialTranscript(input);
  const internal = normalizeDecodedSessionInternal(decoded, bounds, {
    partial,
    filters,
  });
  const groupId = resolveGroupId(
    input.source,
    internal.context.sourceGroupId,
    input.sourceContext?.groupId,
    internal.context.sourceGroupAmbiguous ?? false,
    internal.context.sourceGroupRequired ?? false,
  );
  return finalizeCanonical(internal, bounds, {
    groupId,
    baseByteOffset,
    // Meta emission is tied to the byte offset, not the partial flag: the initial
    // range (offset 0) emits the authoritative meta even when it is a partial chunk.
    emitMeta: baseByteOffset === 0,
  });
}

function isPartialTranscript(input: NormalizeInput): boolean {
  return (
    (input.sourceContext?.partial ?? false) ||
    (input.sourceContext?.baseByteOffset ?? 0) > 0
  );
}

/**
 * Resolve the authoritative source group. Caller context fills a missing
 * adapter-detected group but must not silently override a detected one: a
 * disagreement fails so the upload can be quarantined. Location-anchored
 * sources (Codex and Cursor), ambiguous inputs, and native shapes with no
 * grouping metadata require a resolved group rather than falling back to a
 * sentinel, which would turn missing context into durable bad identity.
 */
function resolveGroupId(
  source: TranscriptTrajectorySource,
  detected: string | undefined,
  provided: string | undefined,
  ambiguous: boolean,
  required: boolean,
): string {
  if (ambiguous && !provided) {
    throw new NormalizationError(
      "source_group_required",
      `Canonical ${source} normalization found multiple source groups; pass sourceContext.groupId.`,
    );
  }
  if (required && !provided) {
    throw new NormalizationError(
      "source_group_required",
      `Canonical ${source} normalization has no source group; pass sourceContext.groupId.`,
    );
  }
  if (detected && provided && detected !== provided) {
    throw new NormalizationError(
      "source_group_conflict",
      `Detected source group ${JSON.stringify(detected)} conflicts with the provided source context group ${JSON.stringify(provided)}.`,
    );
  }
  const resolved = detected || provided;
  if ((source === "codex" || source === "cursor") && !resolved) {
    const sourceLabel = source === "codex" ? "Codex" : "Cursor";
    const discoveryHint = source === "codex" ? "include session_meta or " : "";
    throw new NormalizationError(
      "source_group_required",
      `Canonical ${sourceLabel} normalization requires a source group: ` +
        `${discoveryHint}pass sourceContext.groupId.`,
    );
  }
  return resolved || GROUP_SENTINEL;
}

export {
  loadDeepAgentsCheckpoint,
  normalizeCheckpoint,
  normalizeCheckpointToCanonical,
  type DeepAgentsAIMessageData,
  type DeepAgentsCheckpointData,
  type DeepAgentsCheckpointInput,
  type DeepAgentsCheckpointLocation,
  type DeepAgentsHumanMessageData,
  type DeepAgentsMessageData,
  type DeepAgentsToolCall,
  type DeepAgentsToolMessageData,
} from "./adapters/deepagents/index.js";
export { CANONICAL_SCHEMA_VERSION, NORMALIZER_VERSION } from "./version.js";

export {
  listTrajectories,
  type ListTrajectoriesInput,
  type ListTrajectoriesResult,
  type TrajectoryListing,
} from "./listing.js";

export { DEFAULT_NORMALIZATION_BOUNDS } from "./bounds.js";
export { DEFAULT_NORMALIZATION_FILTERS } from "./filters.js";
export { validateTranscript } from "./validate.js";
export {
  NormalizationError,
  type AmpExecutionIdentity,
  type AmpModelAttestation,
  type AssistantMessageRecord,
  type AssistantToolCallRecord,
  type AnyTrajectorySource,
  type CanonicalRecord,
  type CanonicalRecordType,
  type CanonicalResult,
  type CheckpointTrajectorySource,
  type Diagnostic,
  type DiagnosticCode,
  type MetaRecord,
  type NormalizationBounds,
  type NormalizationFilters,
  type NormalizationErrorCode,
  type NormalizedRecord,
  type NormalizedTranscript,
  type ObservationRecord,
  type NormalizeInput,
  type NormalizeResult,
  type ReasoningRecord,
  type SourceContext,
  type SourceIdentityKind,
  type SystemMessagePolicy,
  type SystemRecord,
  type ToolCall,
  type ToolArgumentBounds,
  type ToolResultBounds,
  type ToolResultPolicy,
  type ToolResultRecord,
  type ToolResultTruncationStrategy,
  type TranscriptTrajectorySource,
  type TrajectorySource,
  type UserRecord,
} from "./types.js";
export type { ResolvedNormalizationBounds } from "./bounds.js";
