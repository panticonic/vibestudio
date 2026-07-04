import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initialAgentState,
  type AgentLoopConfig,
  type ModelCallEffect,
} from "@workspace/agent-loop";
import { CredentialApprovalDeferredError, type ExecutorDeps } from "./types.js";

const mocks = vi.hoisted(() => ({
  clampThinkingLevel: vi.fn((_model: unknown, level: unknown) => level),
  getModel: vi.fn(),
  stream: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", () => ({
  clampThinkingLevel: mocks.clampThinkingLevel,
  getModel: mocks.getModel,
  stream: mocks.stream,
}));

const { modelCallExecutor, toPiAssistantBlocks, toProtocolBlocks } =
  await import("./model-call.js");

const config: AgentLoopConfig = {
  model: "test:model",
  thinkingLevel: "medium",
  approvalLevel: 2,
  respondPolicy: "all",
  systemPromptHash: "sys",
  activeToolNames: [],
  roster: { participants: [] },
};

function descriptor(): ModelCallEffect {
  return {
    effectId: "model:msg-1",
    kind: "model_call",
    channelId: "channel-1",
    idempotencyKey: "attempt-1",
    messageId: "msg-1",
    turnId: "turn-1",
    request: {
      provider: "test",
      model: "model",
      thinkingLevel: "medium",
      systemPromptHash: "sys",
      activeToolNames: [],
      contextThroughSeq: 0,
      attemptId: "attempt-1",
      streamOptions: { idleTimeoutMs: 25 },
    },
  };
}

function deps(): ExecutorDeps {
  return {
    selfRef: { kind: "agent", id: "agent:self", participantId: "agent:self" },
    blobstore: {
      getText: async () => "",
      putText: async (value) => ({ digest: `digest:${value.length}`, size: value.length }),
    },
    credentials: {
      getApiKey: async () => ({ apiKey: "test-key" }),
      registerCredentialInterest: async () => {},
    },
    channel: {
      callMethod: async () => {},
      publish: async () => {},
      sendSignalEvent: async () => {},
    },
    localTools: {
      run: async () => ({ result: null, isError: false }),
      alreadyApplied: () => false,
    },
    http: {
      post: async () => ({ deferred: false, result: null, isError: false }),
    },
    callbackAddress: { source: "test", className: "Test", objectKey: "obj" },
  };
}

describe("modelCallExecutor", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("defers the model call when credential approval parks server-side", async () => {
    mocks.getModel.mockReturnValue({ baseUrl: "https://model.test" });
    const getApiKey = vi.fn(async () => {
      throw new CredentialApprovalDeferredError("test", "https://model.test");
    });
    const inputDeps = deps();
    inputDeps.credentials.getApiKey = getApiKey;

    await expect(
      modelCallExecutor.execute({
        descriptor: descriptor(),
        state: initialAgentState({ channelId: "channel-1", config }),
        signal: new AbortController().signal,
        deps: inputDeps,
        onEphemeral: () => {},
      })
    ).resolves.toEqual({ deferred: true });

    expect(getApiKey).toHaveBeenCalledWith({
      providerId: "test",
      modelBaseUrl: "https://model.test",
      requestId: "model:msg-1",
      idempotencyKey: "attempt-1",
    });
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("returns a model error and aborts the stream after an idle timeout", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let streamSignal: AbortSignal | undefined;
    mocks.getModel.mockReturnValue({ baseUrl: "https://model.test" });
    mocks.stream.mockImplementation((_model, _context, options: { signal?: AbortSignal }) => {
      streamSignal = options.signal;
      return {
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<Record<string, unknown>>>(() => {}),
          };
        },
        result: async () => ({ content: [], stopReason: "stop" }),
      };
    });

    const outcome = modelCallExecutor.execute({
      descriptor: descriptor(),
      state: initialAgentState({ channelId: "channel-1", config }),
      signal: new AbortController().signal,
      deps: deps(),
      onEphemeral: () => {},
    });

    for (let i = 0; i < 25 && mocks.stream.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    expect(mocks.stream).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(26);

    await expect(outcome).resolves.toMatchObject({
      kind: "model",
      stopReason: "error",
      errorReason: expect.stringContaining("model_stream_idle_timeout"),
    });
    expect(streamSignal?.aborted).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "[model-call] stream idle watchdog fired:",
      expect.objectContaining({
        channelId: "channel-1",
        messageId: "msg-1",
        timeoutMs: 25,
        phase: "stream event",
      })
    );
  });

  it("returns retry-later for retryable provider rate limits", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.getModel.mockReturnValue({ baseUrl: "https://api.openai.com/v1" });
    const rateLimit = Object.assign(new Error("Rate limit reached for requests."), {
      status: 429,
      headers: { "retry-after": "12" },
      body: {
        error: {
          type: "rate_limit_exceeded",
          message: "Rate limit reached for requests.",
        },
      },
    });
    mocks.stream.mockImplementation(() => ({
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            throw rateLimit;
          },
        };
      },
      result: async () => ({ content: [], stopReason: "stop" }),
    }));
    const inputDescriptor = descriptor();
    inputDescriptor.request.provider = "openai";
    inputDescriptor.request.model = "gpt-5.1";

    await expect(
      modelCallExecutor.execute({
        descriptor: inputDescriptor,
        state: initialAgentState({ channelId: "channel-1", config }),
        signal: new AbortController().signal,
        deps: deps(),
        onEphemeral: () => {},
      })
    ).resolves.toMatchObject({
      kind: "retry",
      reason: "Rate limit reached for requests.",
      retryAfterMs: 12_000,
      code: "rate_limited_retryable",
    });
    expect(warn).toHaveBeenCalledWith(
      "[model-call] stream failed:",
      expect.stringContaining("Rate limit reached")
    );
  });

  it("streams thinking deltas and preserves provider replay metadata on completion", async () => {
    const providerModel = {
      id: "claude-sonnet-4-20250514",
      name: "Claude Sonnet 4",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://model.test",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    };
    mocks.getModel.mockReturnValue(providerModel);
    mocks.stream.mockImplementation((_model, _context, options) => {
      expect(options).toMatchObject({
        apiKey: "test-key",
        sessionId: "channel-1:agent:self",
        thinkingEnabled: true,
        thinkingBudgetTokens: 8192,
        maxTokens: 64_000,
      });
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "thinking_delta", contentIndex: 0, delta: "think " };
          yield { type: "text_delta", contentIndex: 1, delta: "done" };
        },
        result: async () => ({
          content: [
            { type: "thinking", thinking: "think ", thinkingSignature: "sig-thinking" },
            {
              type: "text",
              text: "done",
              textSignature: JSON.stringify({ v: 1, id: "resp-msg" }),
            },
          ],
          stopReason: "stop",
          usage: { input: 1, output: 2 },
        }),
      };
    });

    const ephemerals: unknown[] = [];
    const outcome = await modelCallExecutor.execute({
      descriptor: descriptor(),
      state: initialAgentState({ channelId: "channel-1", config }),
      signal: new AbortController().signal,
      deps: deps(),
      onEphemeral: (event) => ephemerals.push(event),
    });

    expect(
      ephemerals.map(
        (event) => (event as { event: { payload: { type: string; text: string } } }).event.payload
      )
    ).toEqual([
      {
        protocol: "agentic.trajectory.v1",
        blockId: "msg-1:block:0",
        type: "thinking",
        text: "think ",
      },
      { protocol: "agentic.trajectory.v1", blockId: "msg-1:block:1", type: "text", text: "done" },
    ]);
    expect(outcome).toMatchObject({
      kind: "model",
      stopReason: "completed",
      blocks: [
        {
          type: "thinking",
          blockId: "msg-1:block:0",
          content: "think ",
          metadata: { pi: { thinkingSignature: "sig-thinking" } },
        },
        {
          type: "text",
          blockId: "msg-1:block:1",
          content: "done",
          metadata: { pi: { textSignature: JSON.stringify({ v: 1, id: "resp-msg" }) } },
        },
      ],
    });
  });

  it("bounds long provider session IDs before streaming", async () => {
    mocks.getModel.mockReturnValue({ baseUrl: "https://chatgpt.com/backend-api" });
    const longDescriptor = descriptor();
    longDescriptor.request.provider = "openai-codex";
    longDescriptor.request.model = "gpt-5.3-codex-spark";
    longDescriptor.channelId = "ctx-panel-tree-panels-chat-mqcwmvir-0fe8dd6c-extra-long";
    const inputDeps = deps();
    inputDeps.selfRef = {
      kind: "agent",
      id: "agent:self",
      participantId: "agent:system-testing-agent-with-long-id",
    };
    mocks.stream.mockImplementation((_model, _context, options) => {
      expect(options.sessionId).toHaveLength(64);
      expect(options.sessionId).toMatch(
        /^ctx-panel-tree-panels-chat-mqcwmvir-0fe8dd6c-.*-[0-9a-z]{14}$/
      );
      return {
        async *[Symbol.asyncIterator]() {},
        result: async () => ({
          content: [{ type: "text", text: "ok" }],
          stopReason: "stop",
          usage: { input: 1, output: 1 },
        }),
      };
    });

    await expect(
      modelCallExecutor.execute({
        descriptor: longDescriptor,
        state: initialAgentState({ channelId: longDescriptor.channelId, config }),
        signal: new AbortController().signal,
        deps: inputDeps,
        onEphemeral: () => {},
      })
    ).resolves.toMatchObject({
      kind: "model",
      stopReason: "completed",
      blocks: [expect.objectContaining({ content: "ok" })],
    });
  });

  it("appends immediate prompts after transcript messages without changing the system prompt", async () => {
    mocks.getModel.mockReturnValue({ baseUrl: "https://model.test" });
    const inputDescriptor = descriptor();
    inputDescriptor.request.contextThroughSeq = 1;
    inputDescriptor.request.immediatePrompt =
      "## Subagent Operating Contract\nOnly `complete` ends this subagent run.";
    const inputDeps = deps();
    inputDeps.blobstore.getText = async (digest) => (digest === "sys" ? "BASE SYSTEM" : "");
    let streamedContext: unknown;
    mocks.stream.mockImplementation((_model, context) => {
      streamedContext = context;
      return {
        async *[Symbol.asyncIterator]() {},
        result: async () => ({
          content: [{ type: "text", text: "ok" }],
          stopReason: "stop",
          usage: { input: 1, output: 1 },
        }),
      };
    });

    await expect(
      modelCallExecutor.execute({
        descriptor: inputDescriptor,
        state: {
          ...initialAgentState({ channelId: "channel-1", config }),
          entries: [
            {
              kind: "user",
              seq: 1,
              envelopeId: "env-1",
              content: "Original request",
            },
          ],
        },
        signal: new AbortController().signal,
        deps: inputDeps,
        onEphemeral: () => {},
      })
    ).resolves.toMatchObject({ kind: "model", stopReason: "completed" });

    expect(streamedContext).toMatchObject({
      systemPrompt: "BASE SYSTEM",
      messages: [
        { role: "user", content: [{ type: "text", text: "Original request" }] },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "## Subagent Operating Contract\nOnly `complete` ends this subagent run.",
            },
          ],
        },
      ],
    });
  });

  it("returns a deterministic OpenAI Codex response in VIBEZ1_TEST_MODE without credential lookup", async () => {
    const previous = process.env["VIBEZ1_TEST_MODE"];
    delete process.env["VIBEZ1_TEST_MODE"];
    try {
      mocks.getModel.mockReturnValue({ baseUrl: "https://chatgpt.com/backend-api" });
      const getApiKey = vi.fn(async () => ({ apiKey: "test-key" }));
      const inputDeps = deps();
      inputDeps.credentials.getApiKey = getApiKey;
      inputDeps.env = { VIBEZ1_TEST_MODE: "1" };
      const inputDescriptor = descriptor();
      inputDescriptor.request.provider = "openai-codex";
      inputDescriptor.request.model = "gpt-5.3-codex-spark";

      const outcome = await modelCallExecutor.execute({
        descriptor: inputDescriptor,
        state: initialAgentState({ channelId: "channel-1", config }),
        signal: new AbortController().signal,
        deps: inputDeps,
        onEphemeral: () => {},
      });

      expect(getApiKey).not.toHaveBeenCalled();
      expect(mocks.stream).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({
        kind: "model",
        stopReason: "completed",
        blocks: [
          {
            type: "text",
            content: "E2E model response: initial agent turn completed.",
          },
        ],
      });
    } finally {
      if (previous === undefined) {
        delete process.env["VIBEZ1_TEST_MODE"];
      } else {
        process.env["VIBEZ1_TEST_MODE"] = previous;
      }
    }
  });

  it("round-trips pi replay signatures through protocol block metadata", () => {
    const protocolBlocks = toProtocolBlocks(
      [
        {
          type: "thinking",
          thinking: "[Reasoning redacted]",
          thinkingSignature: "sig-1",
          redacted: true,
        },
        { type: "text", text: "visible", textSignature: "text-sig-1" },
        {
          type: "toolCall",
          id: "tool-1",
          name: "read",
          arguments: { path: "a.ts" },
          thoughtSignature: "tool-sig-1",
        },
      ],
      "msg-1"
    );

    expect(protocolBlocks).toEqual([
      {
        type: "thinking",
        blockId: "msg-1:block:0",
        content: "[Reasoning redacted]",
        metadata: { pi: { thinkingSignature: "sig-1", redacted: true } },
      },
      {
        type: "text",
        blockId: "msg-1:block:1",
        content: "visible",
        metadata: { pi: { textSignature: "text-sig-1" } },
      },
      {
        type: "toolCall",
        id: "tool-1",
        name: "read",
        arguments: { path: "a.ts" },
        metadata: { pi: { thoughtSignature: "tool-sig-1" } },
      },
    ]);
    expect(toPiAssistantBlocks(protocolBlocks)).toEqual([
      {
        type: "thinking",
        thinking: "[Reasoning redacted]",
        thinkingSignature: "sig-1",
        redacted: true,
      },
      { type: "text", text: "visible", textSignature: "text-sig-1" },
      {
        type: "toolCall",
        id: "tool-1",
        name: "read",
        arguments: { path: "a.ts" },
        thoughtSignature: "tool-sig-1",
      },
    ]);
  });

  it("does not emit model-call traces unless tracing is enabled", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const inputDescriptor = descriptor();
    inputDescriptor.request.provider = "openai-codex";
    inputDescriptor.request.model = "gpt-5.3-codex-spark";

    await modelCallExecutor.execute({
      descriptor: inputDescriptor,
      state: initialAgentState({ channelId: "channel-1", config }),
      signal: new AbortController().signal,
      deps: { ...deps(), env: { VIBEZ1_TEST_MODE: "1" } },
      onEphemeral: () => {},
    });
    expect(info).not.toHaveBeenCalled();

    await modelCallExecutor.execute({
      descriptor: inputDescriptor,
      state: initialAgentState({ channelId: "channel-1", config }),
      signal: new AbortController().signal,
      deps: { ...deps(), env: { VIBEZ1_TEST_MODE: "1", VIBEZ1_MODEL_CALL_TRACE: "1" } },
      onEphemeral: () => {},
    });
    expect(info).toHaveBeenCalledWith(
      "[model-call] trace:",
      expect.objectContaining({ stage: "start", provider: "openai-codex" })
    );
  });
});
