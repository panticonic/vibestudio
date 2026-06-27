import { describe, expect, it } from "vitest";
import {
  appendInstalledAgent,
  buildAgentSubscriptionConfig,
  resolveChatContextId,
  sanitizeHandle,
  type InstalledAgentRecord,
} from "./bootstrap.js";

const HANDLE_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

describe("sanitizeHandle", () => {
  it("passes through an already-valid handle", () => {
    expect(sanitizeHandle("ai-chat")).toBe("ai-chat");
    expect(sanitizeHandle("Test_Agent-1")).toBe("Test_Agent-1");
  });

  it("replaces invalid characters with hyphens", () => {
    expect(sanitizeHandle("Gmail Agent")).toBe("Gmail-Agent");
    expect(sanitizeHandle("a.b/c")).toBe("a-b-c");
  });

  it("drops a leading non-letter run so it always starts with a letter", () => {
    expect(sanitizeHandle("123-agent")).toBe("agent");
    expect(sanitizeHandle("-_-bot")).toBe("bot");
  });

  it("falls back to the default when nothing valid remains", () => {
    expect(sanitizeHandle("")).toBe("ai-chat");
    expect(sanitizeHandle("123")).toBe("ai-chat");
    expect(sanitizeHandle("***", "fallback")).toBe("fallback");
  });

  it("caps length to leave room for a -xxxx suffix", () => {
    const out = sanitizeHandle("a".repeat(200));
    expect(out.length).toBe(50);
  });

  it("always yields a base handle that (with a 4-char suffix) is a valid handle", () => {
    for (const raw of ["Gmail Agent", "123-agent", "", "OnboardingAgentWorker", "a".repeat(200), "@#$%"]) {
      const handle = `${sanitizeHandle(raw)}-abcd`;
      expect(handle).toMatch(HANDLE_RE);
    }
  });
});

describe("resolveChatContextId", () => {
  it("prefers the state-args context when present", () => {
    expect(resolveChatContextId("ctx-from-state", "ctx-from-runtime")).toBe("ctx-from-state");
  });

  it("falls back to the runtime context", () => {
    expect(resolveChatContextId(undefined, "ctx-from-runtime")).toBe("ctx-from-runtime");
  });

  it("returns null when no usable context is available", () => {
    expect(resolveChatContextId(undefined, undefined)).toBeUndefined();
    expect(resolveChatContextId("", "   ")).toBeUndefined();
  });
});

describe("appendInstalledAgent", () => {
  const sample: InstalledAgentRecord = {
    agentId: "AiChatWorker",
    handle: "ai-chat-abcd",
    key: "ai-chat-abcd-12345678",
    source: "workers/agent-worker",
    className: "AiChatWorker",
  };

  it("creates a new array when existing is undefined", () => {
    const next = appendInstalledAgent(undefined, sample);
    expect(next).toEqual([sample]);
  });

  it("appends to an existing array without mutating it", () => {
    const existing: InstalledAgentRecord[] = [
      { agentId: "A", handle: "a", key: "a-1", source: "src", className: "A" },
    ];
    const next = appendInstalledAgent(existing, sample);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual(existing[0]);
    expect(next[1]).toEqual(sample);
    // Source array must not be mutated.
    expect(existing).toHaveLength(1);
  });

  it("preserves all persisted fields needed by bootstrap rehydration", () => {
    const next = appendInstalledAgent(undefined, sample);
    const persisted = next[0]!;
    // These exact fields are read by the rehydration block in index.tsx
    expect(persisted.agentId).toBe(sample.agentId);
    expect(persisted.handle).toBe(sample.handle);
    expect(persisted.key).toBe(sample.key);
    expect(persisted.source).toBe(sample.source);
    expect(persisted.className).toBe(sample.className);
  });
});

describe("buildAgentSubscriptionConfig", () => {
  it("layers full workspace defaults under global and per-agent config", () => {
    const result = buildAgentSubscriptionConfig({
      handle: "ai-chat-abcd",
      workspaceDefaultAgentConfig: {
        model: "openai:gpt-5",
        thinkingLevel: "high",
        approvalLevel: 1,
      },
      globalConfig: {
        approvalLevel: 2,
        systemPrompt: "global prompt",
      },
      perAgentConfig: {
        model: "anthropic:claude-opus-4-1",
      },
    });

    expect(result.subscribeConfig).toMatchObject({
      model: "anthropic:claude-opus-4-1",
      thinkingLevel: "high",
      approvalLevel: 2,
      systemPrompt: "global prompt",
      handle: "ai-chat-abcd",
    });
  });

  it("persists effective model and behavior defaults into the per-agent record", () => {
    const result = buildAgentSubscriptionConfig({
      handle: "ai-chat-abcd",
      workspaceDefaultAgentConfig: {
        model: "openai:gpt-5",
        thinkingLevel: "medium",
        approvalLevel: 1,
      },
      perAgentConfig: {},
    });

    expect(result.perAgent).toEqual({
      model: "openai:gpt-5",
      thinkingLevel: "medium",
      approvalLevel: 1,
    });
  });

  it("strips caller-provided handles and applies panel-derived handle last", () => {
    const result = buildAgentSubscriptionConfig({
      handle: "safe-handle",
      workspaceDefaultAgentConfig: { model: "openai:gpt-5" },
      perAgentConfig: {
        handle: "unsafe handle",
        approvalLevel: 0,
      },
    });

    expect(result.subscribeConfig).toMatchObject({
      model: "openai:gpt-5",
      approvalLevel: 0,
      handle: "safe-handle",
    });
    expect(result.perAgent).not.toHaveProperty("handle");
  });
});
