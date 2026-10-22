import { describe, expect, test } from "bun:test";
import {
  inspectAmpExecutionInit,
  inspectClaudeCodeStream,
  inspectCodexExecStream,
} from "../src/index.js";

const lines = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");

describe("inspectCodexExecStream", () => {
  test("reads a finished run's thread, turns, reroutes, tool outcomes and tokens", () => {
    const stream = lines(
      { type: "thread.started", thread_id: "thread-1" },
      { type: "turn.started" },
      { type: "item.started", item: { id: "cmd-1", type: "command_execution" } },
      { type: "item.completed", item: { id: "cmd-1", type: "command_execution", status: "completed", exit_code: 0 } },
      { type: "item.completed", item: { id: "cmd-2", type: "command_execution", status: "completed", exit_code: 2 } },
      { type: "item.completed", item: { id: "msg-1", type: "agent_message", text: "hi" } },
      { type: "item.completed", item: { id: "err-1", type: "error", message: "model rerouted: gpt-a -> gpt-b" } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 5 } },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "patch-1", type: "file_change", status: "failed" } },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } },
    );

    expect(inspectCodexExecStream(stream)).toEqual({
      threadId: "thread-1",
      turnCount: 2,
      reroutedModels: ["gpt-b"],
      toolCallCount: 3,
      succeededCallIds: ["cmd-1"],
      failedCallIds: ["cmd-2", "patch-1"],
      tokenCount: 18,
      terminalError: null,
    });
  });

  test("reads a run stopped mid-turn without inventing a token total", () => {
    const stream = `${lines(
      { type: "thread.started", thread_id: "thread-1" },
      { type: "turn.started" },
      { type: "item.started", item: { id: "cmd-1", type: "command_execution" } },
      { type: "turn.failed", error: { message: "stream disconnected" } },
    )}\n{"type":"item.comp`;

    expect(inspectCodexExecStream(stream)).toEqual({
      threadId: "thread-1",
      turnCount: 1,
      reroutedModels: [],
      toolCallCount: 1,
      succeededCallIds: [],
      failedCallIds: [],
      tokenCount: null,
      terminalError: "stream disconnected",
    });
  });

  test("refuses malformed records and usage", () => {
    for (const stream of [
      `not json\n${lines({ type: "turn.started" })}`,
      lines([1]),
      lines({ type: "turn.started" }, { type: "turn.completed", usage: { input_tokens: -1, output_tokens: 1 } }),
      lines({ type: "turn.started" }, { type: "turn.completed", usage: "invalid" }),
      lines({ type: "turn.started" }, { type: "turn.completed", usage: [] }),
    ]) {
      expect(() => inspectCodexExecStream(stream)).toThrow(
        expect.objectContaining({ code: "invalid_input" }),
      );
    }
    expect(
      inspectCodexExecStream(
        lines({ type: "thread.started", thread_id: "a" }, { type: "thread.started", thread_id: "b" }),
      ).threadId,
    ).toBeNull();
    // Absent or null usage is unknown, not malformed.
    expect(
      inspectCodexExecStream(lines({ type: "turn.started" }, { type: "turn.completed", usage: null })).tokenCount,
    ).toBeNull();
  });
});

describe("inspectClaudeCodeStream", () => {
  const session = "session-1";
  const assistant = (model: string, content: unknown[], extra: Record<string, unknown> = {}) => ({
    type: "assistant",
    session_id: session,
    parent_tool_use_id: null,
    message: { model, content },
    ...extra,
  });
  const result = (id: string, isError: boolean, extra: Record<string, unknown> = {}) => ({
    type: "user",
    session_id: session,
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError }] },
    ...extra,
  });

  test("counts only the main session and reads its models, tool outcomes and tokens", () => {
    const stream = lines(
      { type: "system", subtype: "init", session_id: session },
      assistant("claude-a", [{ type: "tool_use", id: "t1" }, { type: "tool_use", id: "t2" }]),
      result("t1", false),
      result("t2", true),
      assistant("<synthetic>", [{ type: "text", text: "rate limited" }]),
      assistant("claude-b", [{ type: "tool_use", id: "t3" }]),
      result("t3", false),
      assistant("claude-sub", [{ type: "tool_use", id: "s1" }], { parent_tool_use_id: "t3" }),
      assistant("claude-side", [{ type: "tool_use", id: "s2" }], { isSidechain: true }),
      assistant("claude-other", [{ type: "tool_use", id: "o1" }], { session_id: "other" }),
      {
        type: "result",
        session_id: session,
        is_error: false,
        modelUsage: {
          "claude-a": { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 },
          "claude-b": { inputTokens: 10, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        },
      },
    );

    expect(inspectClaudeCodeStream(stream)).toEqual({
      sessionId: session,
      servedModels: ["claude-a", "claude-b"],
      toolCallCount: 3,
      succeededCallIds: ["t1", "t3"],
      failedCallIds: ["t2"],
      tokenCount: 20,
      terminalFailure: null,
    });
  });

  test("reports the last main-session result's failure and unknown tokens", () => {
    const stream = lines(
      { type: "system", subtype: "init", session_id: session },
      assistant("claude-a", [{ type: "text", text: "hi" }]),
      { type: "result", session_id: session, is_error: true, api_error_status: 529, result: "Overloaded", modelUsage: {} },
    );

    expect(inspectClaudeCodeStream(stream)).toMatchObject({
      tokenCount: null,
      terminalFailure: { apiErrorStatus: 529, text: "Overloaded" },
    });
    expect(inspectClaudeCodeStream(lines(assistant("claude-a", []))).sessionId).toBeNull();

    // A subagent or sidechain result after the main one does not replace it.
    const main = { type: "result", session_id: session, is_error: false, modelUsage: {
      "claude-a": { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    } };
    const excluded = lines(
      { type: "system", subtype: "init", session_id: session },
      main,
      { type: "result", session_id: session, parent_tool_use_id: "t1", is_error: true, result: "sub failed", modelUsage: {} },
      { type: "result", session_id: session, isSidechain: true, is_error: true, result: "side failed", modelUsage: {} },
    );
    expect(inspectClaudeCodeStream(excluded)).toMatchObject({ tokenCount: 2, terminalFailure: null });
  });
});

describe("inspectAmpExecutionInit", () => {
  test("reads the init record's MCP servers", () => {
    const stream = lines(
      {
        type: "system",
        subtype: "init",
        mcp_servers: [{ name: "linear", status: "connected" }, { name: "docs" }, { status: "failed" }],
      },
      { type: "assistant" },
    );

    expect(inspectAmpExecutionInit(stream)).toEqual({
      mcpServers: [
        { name: "linear", status: "connected" },
        { name: "docs", status: null },
      ],
    });
    expect(inspectAmpExecutionInit(lines({ type: "assistant" }))).toEqual({ mcpServers: null });
  });
});
