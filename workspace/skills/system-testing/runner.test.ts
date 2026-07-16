import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  messageListeners: [] as Array<(message: Record<string, unknown>) => void>,
  createWithAgent: vi.fn(async (config: unknown) => {
    const session = {
      config,
      onMessage(listener: (message: Record<string, unknown>) => void) {
        mocks.messageListeners.push(listener);
        return () => undefined;
      },
    };
    return session;
  }),
  rpc: {
    selfId: "do:vibestudio/internal:EvalDO:test-eval",
    call: vi.fn(),
  },
  gad: {},
  vcs: {
    deleteRepo: vi.fn(),
  },
}));

vi.mock("@workspace/agentic-session", () => ({
  HeadlessSession: { createWithAgent: mocks.createWithAgent },
}));

vi.mock("@workspace/runtime", () => ({
  gad: mocks.gad,
  rpc: mocks.rpc,
  vcs: mocks.vcs,
}));

import {
  SYSTEM_TEST_AGENT_MODEL,
  SYSTEM_TEST_FALLBACK_MODEL,
  SYSTEM_TEST_FALLBACK_THINKING_LEVEL,
} from "./config.js";
import { HeadlessRunner, SYSTEM_TEST_AGENT_PROMPT } from "./runner.js";

describe("HeadlessRunner", () => {
  beforeEach(() => {
    mocks.createWithAgent.mockClear();
    mocks.rpc.call.mockClear();
    mocks.vcs.deleteRepo.mockReset();
    mocks.messageListeners.length = 0;
  });

  it("spawns bounded system-test agents in isolated contexts", async () => {
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
    expect(config.extraConfig["approvalLevel"]).toBe(2);
    expect(config.extraConfig["fallbackModel"]).toBeUndefined();
    expect(config.extraConfig).not.toHaveProperty("modelStreamIdleTimeoutMs");
    expect(config.extraConfig).not.toHaveProperty("maxModelCallsPerTurn");
  });

  it("uses Luna at minimal effort only after Spark reports its terminal usage limit", async () => {
    const runner = new HeadlessRunner("ctx-test");

    await runner.forTest("first").spawn();
    const first = mocks.createWithAgent.mock.calls[0]![0] as {
      extraConfig: Record<string, unknown>;
    };
    expect(first.extraConfig).toMatchObject({
      model: SYSTEM_TEST_AGENT_MODEL,
      fallbackModel: SYSTEM_TEST_FALLBACK_MODEL,
      fallbackThinkingLevel: SYSTEM_TEST_FALLBACK_THINKING_LEVEL,
      fallbackOn: ["usage_limit_terminal"],
      fallbackScope: "all-turns",
    });

    mocks.messageListeners[0]?.({
      diagnostic: { code: "message_failed", failureCode: "usage_limit_terminal" },
    });
    await runner.forTest("second").spawn();
    const second = mocks.createWithAgent.mock.calls[1]![0] as {
      extraConfig: Record<string, unknown>;
    };
    expect(second.extraConfig).toMatchObject({
      model: SYSTEM_TEST_FALLBACK_MODEL,
      thinkingLevel: SYSTEM_TEST_FALLBACK_THINKING_LEVEL,
    });
    expect(second.extraConfig).not.toHaveProperty("fallbackModel");
    expect(runner.modelPolicySnapshot()).toMatchObject({
      primaryModel: SYSTEM_TEST_AGENT_MODEL,
      activeModel: SYSTEM_TEST_FALLBACK_MODEL,
      activations: [
        {
          testName: "first",
          fromModel: SYSTEM_TEST_AGENT_MODEL,
          toModel: SYSTEM_TEST_FALLBACK_MODEL,
          failureCode: "usage_limit_terminal",
        },
      ],
    });
  });

  it("keeps concurrent sessions on their own model route when one activates fallback", async () => {
    const runner = new HeadlessRunner("ctx-test");
    const firstRunner = runner.forTest("first");
    const secondRunner = runner.forTest("second");
    const firstSession = await firstRunner.spawn();
    const secondSession = await secondRunner.spawn();

    mocks.messageListeners[0]?.({
      diagnostic: { code: "message_failed", failureCode: "usage_limit_terminal" },
    });

    expect(firstRunner.modelPolicySnapshot(firstSession)).toMatchObject({
      primaryModel: SYSTEM_TEST_AGENT_MODEL,
      activeModel: SYSTEM_TEST_FALLBACK_MODEL,
    });
    expect(secondRunner.modelPolicySnapshot(secondSession)).toMatchObject({
      primaryModel: SYSTEM_TEST_AGENT_MODEL,
      activeModel: SYSTEM_TEST_AGENT_MODEL,
      activations: [],
    });
    expect(runner.modelPolicySnapshot()).toMatchObject({
      activeModel: SYSTEM_TEST_FALLBACK_MODEL,
    });
  });

  it("runs an explicit Luna override at minimal effort", async () => {
    const runner = new HeadlessRunner("ctx-test", { model: SYSTEM_TEST_FALLBACK_MODEL });

    await runner.spawn();

    const config = mocks.createWithAgent.mock.calls[0]![0] as {
      extraConfig: Record<string, unknown>;
    };
    expect(config.extraConfig).toMatchObject({
      model: SYSTEM_TEST_FALLBACK_MODEL,
      thinkingLevel: SYSTEM_TEST_FALLBACK_THINKING_LEVEL,
    });
  });

  it("can explicitly spawn in the orchestrator context", async () => {
    const runner = new HeadlessRunner("ctx-test");

    await runner.spawn({ context: "parent" });

    expect(mocks.createWithAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        contextId: "ctx-test",
        extraConfig: expect.objectContaining({ model: SYSTEM_TEST_AGENT_MODEL }),
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
    expect(SYSTEM_TEST_AGENT_PROMPT).toContain("closest user-facing skill");
    expect(SYSTEM_TEST_AGENT_PROMPT).toContain("Do not inspect");
    expect(SYSTEM_TEST_AGENT_PROMPT).toContain("exercise the documented path honestly");
    expect(SYSTEM_TEST_AGENT_PROMPT).toContain("most straightforward supported approach");
    expect(SYSTEM_TEST_AGENT_PROMPT).toContain("If that documented approach fails, stop");
    expect(SYSTEM_TEST_AGENT_PROMPT).toContain("When reporting a failure");
    expect(SYSTEM_TEST_AGENT_PROMPT).toContain("exact error or unexpected result");
    expect(SYSTEM_TEST_AGENT_PROMPT).toContain("there is no initial visible panel ancestor");
    expect(SYSTEM_TEST_AGENT_PROMPT).toContain("create an owned root panel explicitly");
    expect(SYSTEM_TEST_AGENT_PROMPT).not.toContain("smallest relevant canonical workspace docs");
  });

  it("owns a namespaced published-repo fixture lifecycle outside the user prompt", async () => {
    const runner = new HeadlessRunner("ctx-test").forTest("docs-workspace-loop", {
      workspaceRepoFixture: true,
    });
    const repoName = runner.workspaceRepoName!;
    const prefix = "system-test-docs-workspace-loop-";
    const refs = (...repoPaths: string[]) => repoPaths.map((repoPath) => ({ repoPath }));
    mocks.rpc.call
      .mockResolvedValueOnce(refs("panels/normal", `panels/${prefix}stale`))
      .mockResolvedValueOnce(refs("panels/normal"))
      .mockResolvedValueOnce(
        refs("panels/normal", `panels/${repoName}`, "panels/outside-fixture")
      )
      .mockResolvedValueOnce(refs("panels/normal", "panels/outside-fixture"));
    mocks.vcs.deleteRepo.mockResolvedValue({ archived: true });

    const state = await runner.prepareWorkspaceRepoFixture();
    await runner.spawn();
    const cleanup = await runner.cleanupWorkspaceRepoFixture(state);

    expect(state).toMatchObject({
      testName: "docs-workspace-loop",
      repoName,
      repoNamePrefix: prefix,
      staleReposRemoved: [`panels/${prefix}stale`],
      reposBefore: ["panels/normal"],
    });
    expect(cleanup).toEqual({
      reposRemoved: [`panels/${repoName}`],
      escapedRepos: ["panels/outside-fixture"],
      reposAfter: ["panels/normal", "panels/outside-fixture"],
    });
    expect(mocks.vcs.deleteRepo).toHaveBeenNthCalledWith(1, {
      repoPath: `panels/${prefix}stale`,
      force: true,
    });
    expect(mocks.vcs.deleteRepo).toHaveBeenNthCalledWith(2, {
      repoPath: `panels/${repoName}`,
      force: true,
    });
    const config = mocks.createWithAgent.mock.calls[0]![0] as {
      extraConfig: Record<string, unknown>;
    };
    expect(config.extraConfig["systemPrompt"]).toContain(
      `use the exact repo basename ${JSON.stringify(repoName)}`
    );
  });

  it("reclaims an active repo fixture from the terminal cleanup owner", async () => {
    const root = new HeadlessRunner("ctx-test");
    const runner = root.forTest("cancelled-fixture", { workspaceRepoFixture: true });
    const repoName = runner.workspaceRepoName!;
    const refs = (...repoPaths: string[]) => repoPaths.map((repoPath) => ({ repoPath }));
    mocks.rpc.call
      .mockResolvedValueOnce(refs())
      .mockResolvedValueOnce(refs("panels/normal"))
      .mockResolvedValueOnce(refs("panels/normal", `panels/${repoName}`))
      .mockResolvedValueOnce(refs("panels/normal"));
    mocks.vcs.deleteRepo.mockResolvedValue({ archived: true });

    await runner.prepareWorkspaceRepoFixture();
    await root.closeAll();
    await root.closeAll();

    expect(mocks.vcs.deleteRepo).toHaveBeenCalledOnce();
    expect(mocks.vcs.deleteRepo).toHaveBeenCalledWith({
      repoPath: `panels/${repoName}`,
      force: true,
    });
    expect(mocks.rpc.call).toHaveBeenCalledTimes(4);
  });
});
