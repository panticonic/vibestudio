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
  blobstore: { putText: vi.fn() },
  vcs: {
    status: vi.fn(),
    inspect: vi.fn(),
    neighbors: vi.fn(),
    history: vi.fn(),
    importSnapshot: vi.fn(),
    revert: vi.fn(),
    commit: vi.fn(),
    push: vi.fn(),
  },
}));

vi.mock("@workspace/agentic-session", () => ({
  HeadlessSession: { createWithAgent: mocks.createWithAgent },
}));

vi.mock("@workspace/runtime", () => ({
  gad: mocks.gad,
  blobstore: mocks.blobstore,
  rpc: mocks.rpc,
  vcs: mocks.vcs,
}));

import { SYSTEM_TEST_AGENT_MODEL } from "./config.js";
import { HeadlessRunner, SYSTEM_TEST_AGENT_PROMPT } from "./runner.js";
import { CONTENT_WORKSPACE_REPO_FIXTURE, CREATED_PANEL_WORKSPACE_REPO_FIXTURE } from "./types.js";

describe("HeadlessRunner", () => {
  beforeEach(() => {
    mocks.createWithAgent.mockClear();
    mocks.rpc.call.mockReset();
    for (const method of Object.values(mocks.vcs)) method.mockReset();
    mocks.blobstore.putText.mockReset();
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

  it("keeps GPT-5.4 mini pinned without a usage-limit fallback", async () => {
    const runner = new HeadlessRunner("ctx-test");

    await runner.forTest("first").spawn();
    const first = mocks.createWithAgent.mock.calls[0]![0] as {
      extraConfig: Record<string, unknown>;
    };
    expect(first.extraConfig).toMatchObject({
      model: SYSTEM_TEST_AGENT_MODEL,
    });
    expect(first.extraConfig).not.toHaveProperty("fallbackModel");

    mocks.messageListeners[0]?.({
      diagnostic: { code: "message_failed", failureCode: "usage_limit_terminal" },
    });
    await runner.forTest("second").spawn();
    const second = mocks.createWithAgent.mock.calls[1]![0] as {
      extraConfig: Record<string, unknown>;
    };
    expect(second.extraConfig).toMatchObject({
      model: SYSTEM_TEST_AGENT_MODEL,
    });
    expect(second.extraConfig).not.toHaveProperty("fallbackModel");
    expect(runner.modelPolicySnapshot()).toMatchObject({
      primaryModel: SYSTEM_TEST_AGENT_MODEL,
      activeModel: SYSTEM_TEST_AGENT_MODEL,
      fallbackModel: null,
      activations: [],
    });
  });

  it("does not attach a fallback route to an explicit model override", async () => {
    const runner = new HeadlessRunner("ctx-test", { model: SYSTEM_TEST_AGENT_MODEL });

    await runner.spawn();

    const config = mocks.createWithAgent.mock.calls[0]![0] as {
      extraConfig: Record<string, unknown>;
    };
    expect(config.extraConfig).toMatchObject({ model: SYSTEM_TEST_AGENT_MODEL });
    expect(config.extraConfig).not.toHaveProperty("fallbackModel");
    expect(runner.modelPolicySnapshot()).toMatchObject({
      primaryModel: SYSTEM_TEST_AGENT_MODEL,
      activeModel: SYSTEM_TEST_AGENT_MODEL,
      fallbackModel: null,
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

  it("owns an exact local repository fixture lifecycle outside the user prompt", async () => {
    const runner = new HeadlessRunner("ctx-test").forTest("docs-workspace-loop", {
      workspaceRepoFixture: CONTENT_WORKSPACE_REPO_FIXTURE,
    });
    const repoName = runner.workspaceRepoName!;
    const status = (contextId: string, eventId = "event:main", mainEventId = "event:main") => ({
      contextId,
      committed: { kind: "event" as const, eventId },
      workingHead: { kind: "event" as const, eventId },
      clean: true,
      mainEventId,
      mainRelation: eventId === mainEventId ? ("at" as const) : ("ahead" as const),
      workingCounts: { applications: 0, workUnits: 0, changes: 0 },
    });
    mocks.rpc.call
      .mockResolvedValueOnce({ contextId: "ctx-fixture" })
      .mockResolvedValueOnce(undefined);
    mocks.vcs.status
      .mockResolvedValueOnce(status("ctx-fixture"))
      .mockResolvedValueOnce(status("ctx-fixture", "event:import"));
    mocks.vcs.importSnapshot.mockResolvedValueOnce({
      contextId: "ctx-fixture",
      eventId: "event:import",
      workUnitId: "work:import",
      importedRepositoryIds: [`repository:projects/${repoName}`],
    });
    mocks.vcs.inspect
      .mockImplementationOnce(async () => {
        const imported = mocks.vcs.importSnapshot.mock.calls[0]![0] as {
          commandId: string;
          source: { kind: string; uri: string; snapshotRevision: string };
        };
        return {
          root: { kind: "work-unit", workUnitId: "work:import" },
          node: {
            kind: "work-unit",
            value: {
              kind: "import",
              commandId: imported.commandId,
              authoredChangeIds: ["change:repository-create"],
              externalSnapshot: {
                sourceKind: imported.source.kind,
                sourceUri: imported.source.uri,
                snapshotRevision: imported.source.snapshotRevision,
                targetRepositoryIds: [`repository:projects/${repoName}`],
              },
            },
          },
          edges: [],
          hasMoreEdges: false,
        };
      })
      .mockResolvedValueOnce({
        root: { kind: "event", eventId: "event:import" },
        node: {
          kind: "event",
          value: {
            eventId: "event:import",
            applicationIds: ["application:import"],
            parentEventIds: ["event:main"],
          },
        },
        edges: [],
        hasMoreEdges: false,
      });
    mocks.vcs.history.mockResolvedValueOnce({
      root: { kind: "event", eventId: "event:main" },
      entries: [
        {
          node: { kind: "event", eventId: "event:main" },
          createdAt: "2026-07-16T00:00:00.000Z",
          summary: "main",
        },
      ],
      nextCursor: null,
    });

    const state = await runner.prepareWorkspaceRepoFixture();
    await runner.spawn();
    const cleanup = await runner.cleanupWorkspaceRepoFixture(state);

    expect(state).toMatchObject({
      kind: "content",
      section: "projects",
      testName: "docs-workspace-loop",
      contextId: "ctx-fixture",
      repoName,
      repositoryId: `repository:projects/${repoName}`,
      repoPath: `projects/${repoName}`,
      seedFilePaths: [],
      importWorkUnitId: "work:import",
      importChangeIds: ["change:repository-create"],
    });
    expect(cleanup).toEqual({
      publishedFixtureRemoved: null,
      unexpectedPublishedRepositoriesRemoved: [],
      counteractedChangeIds: [],
    });
    expect(mocks.vcs.importSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        contextId: "ctx-fixture",
        repositories: [expect.objectContaining({ repoPath: `projects/${repoName}`, files: [] })],
      })
    );
    expect(mocks.vcs.revert).not.toHaveBeenCalled();
    expect(mocks.vcs.commit).not.toHaveBeenCalled();
    expect(mocks.vcs.push).not.toHaveBeenCalled();
    const config = mocks.createWithAgent.mock.calls[0]![0] as {
      contextId?: string;
      extraConfig: Record<string, unknown>;
    };
    expect(config.contextId).toBe("ctx-fixture");
    expect(config.extraConfig["systemPrompt"]).toContain(
      `the exact disposable repository ${JSON.stringify(`projects/${repoName}`)} is already present`
    );
    expect(config.extraConfig["systemPrompt"]).not.toContain("if the task creates");
    expect(mocks.rpc.call).toHaveBeenNthCalledWith(1, "main", "runtime.createContext", [
      {
        testPolicy: {
          testId: "docs-workspace-loop",
          authority: [
            {
              ruleId: "model-credential",
              capability: "credential.use",
              resource: { kind: "exact", key: "credential.use" },
              tier: "gated",
              decision: "once",
            },
            {
              ruleId: "headless-channel",
              capability: "workspace-service:channel",
              resource: {
                kind: "prefix",
                prefix: "do:workers/pubsub-channel:PubSubChannel:headless-",
              },
              tier: "gated",
              decision: "once",
            },
            {
              ruleId: "semantic-workspace",
              capability: "workspace-service:gad.workspace",
              resource: {
                kind: "exact",
                key: "do:vibestudio/internal:GadWorkspaceDO:workspace-semantic-control-plane",
              },
              tier: "gated",
              decision: "once",
            },
            {
              ruleId: "model-settings",
              capability: "workspace-service:models",
              resource: {
                kind: "exact",
                key: "do:workers/model-settings:ModelSettingsDO:workspace-model-settings",
              },
              tier: "gated",
              decision: "once",
            },
            {
              ruleId: "fixture-publication",
              capability: "workspace-main-advance",
              resource: {
                kind: "exact",
                key: `workspace-source-change:projects/${repoName}:main`,
              },
              tier: "gated",
              decision: "once",
            },
          ],
          userland: [],
          unexpectedPrompts: "fail",
        },
      },
    ]);
    expect(mocks.rpc.call).toHaveBeenNthCalledWith(2, "main", "runtime.destroyContext", [
      { contextId: "ctx-fixture", recursive: true },
    ]);
  });

  it("does not reserve or seed a basename for a task-created repository scope", async () => {
    const runner = new HeadlessRunner("ctx-test").forTest("panel-create", {
      workspaceRepoFixture: CREATED_PANEL_WORKSPACE_REPO_FIXTURE,
    });
    mocks.rpc.call
      .mockResolvedValueOnce({ contextId: "ctx-created" })
      .mockResolvedValueOnce(undefined);
    mocks.vcs.status
      .mockResolvedValueOnce({
        contextId: "ctx-created",
        committed: { kind: "event", eventId: "event:main" },
        workingHead: { kind: "event", eventId: "event:main" },
        clean: true,
        mainEventId: "event:main",
        mainRelation: "at",
        workingCounts: { applications: 0, workUnits: 0, changes: 0 },
      })
      .mockResolvedValueOnce({
        contextId: "ctx-created",
        committed: { kind: "event", eventId: "event:main" },
        workingHead: { kind: "event", eventId: "event:main" },
        clean: true,
        mainEventId: "event:main",
        mainRelation: "at",
        workingCounts: { applications: 0, workUnits: 0, changes: 0 },
      });

    const state = await runner.prepareWorkspaceRepoFixture();
    await runner.spawn();

    expect(runner.workspaceRepoName).toBeNull();
    expect(state).toMatchObject({
      kind: "created-repository",
      section: "panels",
      repoName: null,
      repositoryId: null,
      repoPath: null,
    });
    expect(mocks.vcs.importSnapshot).not.toHaveBeenCalled();
    const config = mocks.createWithAgent.mock.calls[0]![0] as {
      contextId?: string;
      extraConfig: Record<string, unknown>;
    };
    expect(config.contextId).toBe("ctx-created");
    expect(config.extraConfig["systemPrompt"]).toContain(
      'owns exactly one repository that it creates under "panels/"'
    );
    expect(config.extraConfig["systemPrompt"]).not.toContain("system-test-panel-create-");
    expect(mocks.rpc.call).toHaveBeenNthCalledWith(1, "main", "runtime.createContext", [
      {
        testPolicy: expect.objectContaining({
          authority: expect.arrayContaining([
            {
              ruleId: "fixture-publication",
              capability: "workspace-main-advance",
              resource: {
                kind: "prefix",
                prefix: "workspace-source-change:panels/",
              },
              tier: "gated",
              decision: "once",
            },
          ]),
          unexpectedPrompts: "fail",
        }),
      },
    ]);

    await expect(runner.cleanupWorkspaceRepoFixture(state)).rejects.toThrow(
      "expected exactly one task-created repository in panels/, found 0"
    );
    expect(mocks.rpc.call).toHaveBeenLastCalledWith("main", "runtime.destroyContext", [
      { contextId: "ctx-created", recursive: true },
    ]);
  });

  it("preserves structured runner diagnostic failures without serializing stacks", async () => {
    const error = Object.assign(new Error("build provenance unavailable"), {
      name: "RemoteRpcError",
      code: "InternalFailure",
      errorKind: "application",
      errorData: {
        code: "InternalFailure",
        handle: "diagnostic:build:01JABC",
        credential: "must-not-persist",
      },
    });
    mocks.rpc.call.mockRejectedValueOnce(error);

    const diagnostics = await new HeadlessRunner("ctx-test").collectDiagnostics();

    expect(diagnostics).toMatchObject({
      contextId: "ctx-test",
      channelId: null,
      buildProvenanceFailure: {
        phase: "diagnostic:build-provenance",
        error: {
          name: "RemoteRpcError",
          message: "build provenance unavailable",
          code: "InternalFailure",
          errorKind: "application",
          errorData: {
            code: "InternalFailure",
            handle: "diagnostic:build:01JABC",
            credential: "[redacted]",
          },
          diagnosticHandles: ["diagnostic:build:01JABC"],
        },
      },
    });
    expect(JSON.stringify(diagnostics)).not.toContain("must-not-persist");
    expect(diagnostics).not.toHaveProperty("buildProvenanceError");
  });
});
