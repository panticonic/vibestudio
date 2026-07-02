import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createWithAgent: vi.fn(async (config: unknown) => ({ config })),
  rpc: {
    selfId: "do:natstack/internal:EvalDO:test-eval",
    call: vi.fn(),
  },
  gad: {},
}));

vi.mock("@workspace/agentic-session", () => ({
  HeadlessSession: { createWithAgent: mocks.createWithAgent },
}));

vi.mock("@workspace/runtime", () => ({
  gad: mocks.gad,
  rpc: mocks.rpc,
}));

import { HeadlessRunner, SYSTEM_TEST_AGENT_PROMPT } from "./runner.js";

describe("HeadlessRunner", () => {
  beforeEach(() => {
    mocks.createWithAgent.mockClear();
    mocks.rpc.call.mockClear();
  });

  it("spawns system-test agents in isolated contexts without a model-call cap by default", async () => {
    const runner = new HeadlessRunner("ctx-test", { model: "anthropic:test-model" });

    await runner.spawn();

    expect(mocks.createWithAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        extraConfig: expect.objectContaining({
          model: "anthropic:test-model",
        }),
      })
    );
    const config = mocks.createWithAgent.mock.calls[0]![0] as {
      config: { clientId: string };
      extraConfig: Record<string, unknown>;
    };
    expect(config.config.clientId).toBe(mocks.rpc.selfId);
    expect(config).not.toHaveProperty("contextId");
    expect(config.extraConfig).not.toHaveProperty("maxModelCallsPerTurn");
  });

  it("can explicitly spawn in the orchestrator context", async () => {
    const runner = new HeadlessRunner("ctx-test");

    await runner.spawn({ context: "parent" });

    expect(mocks.createWithAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        contextId: "ctx-test",
      })
    );
  });

  it("can opt into synthetic panel UI tools for interaction-surface tests", async () => {
    const runner = new HeadlessRunner("ctx-test");

    await runner.spawn({ syntheticPanelUiTools: true });

    expect(mocks.createWithAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        includeSyntheticPanelUiMethods: true,
      })
    );
  });

  it("prompts system-test agents to probe the documented path instead of solving independently", async () => {
    const runner = new HeadlessRunner("ctx-test");

    await runner.spawn();

    const config = mocks.createWithAgent.mock.calls[0]![0] as {
      extraConfig: Record<string, unknown>;
    };
    expect(config.extraConfig["systemPrompt"]).toBe(SYSTEM_TEST_AGENT_PROMPT);
    expect(SYSTEM_TEST_AGENT_PROMPT).toContain("exercise the documented path honestly");
    expect(SYSTEM_TEST_AGENT_PROMPT).toContain("most straightforward supported approach");
    expect(SYSTEM_TEST_AGENT_PROMPT).toContain("If that documented approach fails, stop");
    expect(SYSTEM_TEST_AGENT_PROMPT).toContain("When reporting a failure");
    expect(SYSTEM_TEST_AGENT_PROMPT).toContain("exact error or unexpected result");
    expect(SYSTEM_TEST_AGENT_PROMPT).not.toContain("smallest relevant canonical workspace docs");
  });
});
