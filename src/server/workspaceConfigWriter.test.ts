import YAML from "yaml";
import { describe, expect, it, vi } from "vitest";
import { createHostCaller, createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import type { WorkspaceVcs } from "./vcsHost/workspaceVcs.js";
import { workspaceConfigDigest } from "@vibestudio/workspace/preparedConfig";
import { sha256HexSyncText } from "@vibestudio/content-addressing";
import { workspaceParticipantIdentity } from "./vcsHost/workspaceHistoryHost.js";
import {
  createWorkspaceConfigMainWriter,
  renderWorkspaceConfigYaml,
} from "./workspaceConfigWriter.js";

const WORKSPACE_ID = "ws_opaque_test";
const INTERNAL_AUTHORIZATION = {} as unknown as NonNullable<ServiceContext["authorization"]>;

const mainState = { kind: "event" as const, eventId: "event:main" };
const editedState = { kind: "application" as const, applicationId: "application:config" };
const committedState = { kind: "event" as const, eventId: "event:config" };
const repositoryRef = {
  kind: "repository" as const,
  state: mainState,
  repositoryId: "repository:meta",
};
const withProtectedMainMutation = <T>(operation: () => Promise<T>): Promise<T> => operation();
const whenSemanticReady = async () => {};

function configReader(initialYaml: string) {
  return vi.fn<(method: string, input: unknown) => Promise<unknown>>(
    async (method: string, input: unknown) => {
      if (method === "vcsStatus") {
        return {
          contextId: (input as { contextId: string }).contextId,
          committed: mainState,
          workingHead: mainState,
          clean: true,
          mainEventId: mainState.eventId,
          mainRelation: "at",
          workingCounts: { applications: 0, workUnits: 0, changes: 0 },
        };
      }
      if (method === "vcsNeighbors") {
        return {
          root: mainState,
          edges: [
            {
              kind: "contains-repository",
              from: mainState,
              to: repositoryRef,
            },
          ],
          nextCursor: null,
        };
      }
      if (method === "vcsInspect") {
        return {
          root: repositoryRef,
          node: {
            kind: "repository",
            state: mainState,
            value: {
              kind: "present",
              repositoryId: "repository:meta",
              repoPath: "meta",
              manifestId: "manifest:meta",
            },
          },
          edges: [],
          hasMoreEdges: false,
        };
      }
      if (method === "vcsListFiles") {
        return {
          state: mainState,
          repositoryId: "repository:meta",
          files: [
            {
              fileId: "file:config",
              path: "vibestudio.yml",
              contentHash: "blob:before",
              mode: 0o644,
              size: initialYaml.length,
              binary: false,
            },
          ],
          nextCursor: null,
        };
      }
      if (method === "vcsReadFile") {
        return {
          repositoryId: "repository:meta",
          fileId: "file:config",
          repoPath: "meta",
          path: "vibestudio.yml",
          contentHash: "blob:before",
          mode: 0o644,
          content: { kind: "text", text: initialYaml },
        };
      }
      if (method === "vcsEdit") {
        return {
          contextId: (input as { contextId: string }).contextId,
          workUnitId: "work-unit:config",
          applicationId: editedState.applicationId,
          changeIds: ["change:config"],
          incorporatedChangeIds: [],
          workingHead: editedState,
        };
      }
      if (method === "vcsCommit") {
        return {
          contextId: (input as { contextId: string }).contextId,
          event: committedState,
          committedApplicationIds: [editedState.applicationId],
          integrationSourceEventIds: [],
        };
      }
      throw new Error(`unexpected semantic call ${method}`);
    }
  );
}

describe("workspaceConfigWriter", () => {
  it("authors settings in a temporary participant copy and preserves the approving caller", async () => {
    const initialYaml = `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\ndefaultRepo: panels/old\n`;
    const author = createHostCaller("server", "server", { userId: "system" } as never);
    const approver = createVerifiedCaller("shell:owner", "shell");
    const canonical = { source: "workers/workspace-source", className: "GadHistoryDO", objectKey: "canonical" };
    const openParticipantScope = vi.fn(async ({ contextId }: { contextId: string }) => ({
      caller: author, contextId, ownerContextId: contextId, canonical, workingHead: "native-main",
      owner: { ...canonical, objectKey: `work-${sha256HexSyncText(workspaceParticipantIdentity(author, contextId))}` },
      dispatch: {
        dispatch: vi.fn(async (_target, method, input) => {
          if (method === "readHistoryStatus") return configReader(initialYaml)("vcsStatus", input);
          if (method === "resolveHistoryRepository")
            return { state: mainState, repositoryId: "repository:meta", repoPath: "meta" };
          throw new Error(`Unexpected native history call ${method}`);
        }),
      },
    }));
    const publishParticipantContext = vi.fn();
    const dropContext = vi.fn();
    const editParticipantContext = vi.fn(async () => ({ head: "native-edited", result: { workingHead: editedState } }));
    const saveParticipantContext = vi.fn(async () => ({ event: committedState }));
    const legacy = vi.fn(() => { throw new Error("Legacy store is unavailable"); });
    const vcs = {
      participantHistoryAttached: true, whenSemanticReady, withProtectedMainMutation,
      openParticipantScope, dropContext, editParticipantContext, saveParticipantContext, publishParticipantContext,
      ensureSemanticContext: legacy, semanticCausalCall: legacy,
      ensureFresh: vi.fn(async () => ({ stateHash: "state:protected" })),
      readFile: vi.fn(async () => ({ content: { kind: "text", text: initialYaml } })),
      readParticipantFiles: vi.fn(async () => [await configReader(initialYaml)("vcsReadFile", {})]),
    } as unknown as WorkspaceVcs;
    const writer = createWorkspaceConfigMainWriter({ workspaceId: WORKSPACE_ID, vcs, authoringCaller: author });
    await expect(writer.wouldMutate((config) => ({ ...config, defaultRepo: "panels/new" }))).resolves.toBe(true);
    expect(openParticipantScope).not.toHaveBeenCalled();
    await expect(writer.applyMutation({
      ctx: { caller: createVerifiedCaller("do:relay", "do"), authorizingCaller: approver },
      mutate: (config) => ({ ...config, defaultRepo: "panels/new" }),
      summary: "change default repo",
    })).resolves.toMatchObject({ changed: true, nextConfig: { defaultRepo: "panels/new" } });
    const contextId = openParticipantScope.mock.calls[0]![0].contextId;
    expect(contextId).toMatch(/^system:workspace-config:/u);
    expect(editParticipantContext).toHaveBeenCalledWith(expect.objectContaining({
      head: "native-main", edit: expect.objectContaining({ contextId, expectedWorkingHead: mainState }),
    }));
    expect(saveParticipantContext).toHaveBeenCalledWith(expect.objectContaining({
      head: "native-edited", commit: expect.objectContaining({ contextId, expectedWorkingHead: editedState }),
    }));
    expect(publishParticipantContext).toHaveBeenCalledWith(expect.objectContaining({
      storageCaller: author, gateContext: { kind: "caller", caller: approver },
      push: expect.objectContaining({
        contextId, expectedMainEventId: mainState.eventId, expectedCommittedEventId: committedState.eventId,
      }),
    }));
    expect(dropContext).toHaveBeenCalledExactlyOnceWith(contextId);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("uses a fresh context, one whole-chain commit, and an exact protected push", async () => {
    const initialYaml = `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\ndefaultRepo: panels/old\n`;
    const semanticCausalCall = configReader(initialYaml);
    const semanticPublishCall = vi.fn(async () => ({
      contextId: "context:config",
      eventId: committedState.eventId,
      mainEventId: committedState.eventId,
      effectId: "effect:publish",
      appliedAt: "2026-07-15T12:00:00.000Z",
    }));
    const ensureSemanticContext = vi.fn(async (_contextId: string) => mainState);
    const vcs = {
      withProtectedMainMutation,
      whenSemanticReady,
      ensureSemanticContext,
      dropContext: vi.fn(async () => undefined),
      semanticCausalCall,
      semanticPublishCall,
    } as unknown as WorkspaceVcs;
    const writer = createWorkspaceConfigMainWriter({ workspaceId: WORKSPACE_ID, vcs });
    const ctx = {
      caller: createVerifiedCaller("shell:dev", "shell"),
      requestId: "request:config",
      authorization: INTERNAL_AUTHORIZATION,
    } satisfies ServiceContext;

    const result = await writer.applyMutation({
      ctx,
      mutate: (config) => ({ ...config, defaultRepo: "panels/new" }),
      summary: "change default repo",
    });

    expect(result).toMatchObject({ changed: true, nextConfig: { defaultRepo: "panels/new" } });
    expect(result.nextConfig.id).toBe(WORKSPACE_ID);
    const contextId = vi.mocked(vcs.ensureSemanticContext).mock.calls[0]?.[0];
    expect(contextId).toMatch(/^system:workspace-config:/);
    expect(vcs.dropContext).toHaveBeenCalledWith(contextId);
    expect(semanticCausalCall.mock.calls.map(([method]) => method)).toEqual([
      "vcsStatus",
      "vcsNeighbors",
      "vcsInspect",
      "vcsListFiles",
      "vcsReadFile",
      "vcsEdit",
      "vcsCommit",
    ]);
    expect(
      semanticCausalCall.mock.calls.find(([method]) => method === "vcsEdit")?.[1]
    ).toMatchObject({
      contextId,
      expectedWorkingHead: mainState,
      changes: [
        {
          kind: "text-edit",
          repositoryId: "repository:meta",
          fileId: "file:config",
        },
      ],
    });
    expect(
      semanticCausalCall.mock.calls.find(([method]) => method === "vcsCommit")?.[1]
    ).toMatchObject({ expectedWorkingHead: editedState });
    expect(semanticPublishCall).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedCommittedEventId: committedState.eventId,
        expectedMainEventId: mainState.eventId,
      }),
      null,
      expect.objectContaining({
        runtime: expect.objectContaining({ id: "shell:dev", kind: "shell" }),
      })
    );
  });

  it("advances the authenticated eval execution context so config writes do not strand the caller", async () => {
    const initialYaml = `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\ndefaultRepo: panels/old\n`;
    const semanticCausalCall = configReader(initialYaml);
    const semanticPublishCall = vi.fn(async () => ({
      contextId: "context:agent-task",
      eventId: committedState.eventId,
      mainEventId: committedState.eventId,
      effectId: "effect:publish",
      appliedAt: "2026-07-15T12:00:00.000Z",
    }));
    const ensureSemanticContext = vi.fn(async () => mainState);
    const vcs = {
      withProtectedMainMutation,
      whenSemanticReady,
      ensureSemanticContext,
      dropContext: vi.fn(async () => undefined),
      semanticCausalCall,
      semanticPublishCall,
    } as unknown as WorkspaceVcs;
    const writer = createWorkspaceConfigMainWriter({ workspaceId: WORKSPACE_ID, vcs });
    const executionSession = {
      contextId: "context:agent-task",
    } as unknown as NonNullable<ServiceContext["caller"]["executionSession"]>;
    const ctx = {
      caller: {
        ...createVerifiedCaller("do:eval", "do"),
        executionSession,
      },
      requestId: "request:agent-config",
      authorization: INTERNAL_AUTHORIZATION,
    } satisfies ServiceContext;

    await expect(
      writer.applyMutation({
        ctx,
        mutate: (config) => ({ ...config, defaultRepo: "panels/new" }),
        summary: "change default repo",
      })
    ).resolves.toMatchObject({ changed: true });

    expect(vcs.ensureSemanticContext).not.toHaveBeenCalled();
    expect(vcs.dropContext).not.toHaveBeenCalled();
    expect(
      semanticCausalCall.mock.calls.find(([method]) => method === "vcsEdit")?.[1]
    ).toMatchObject({ contextId: "context:agent-task" });
    expect(semanticPublishCall).toHaveBeenCalledWith(
      expect.objectContaining({ contextId: "context:agent-task" }),
      null,
      expect.anything()
    );
  });

  it("preserves the authenticated authorizing caller across an extension provider relay", async () => {
    const semanticCausalCall = configReader(
      `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\ndefaultRepo: panels/old\n`
    );
    const semanticPublishCall = vi.fn(async () => ({
      contextId: "context:paired-shell",
      eventId: committedState.eventId,
      mainEventId: committedState.eventId,
      effectId: "effect:publish",
      appliedAt: "2026-07-15T12:00:00.000Z",
    }));
    const vcs = {
      withProtectedMainMutation,
      whenSemanticReady,
      ensureSemanticContext: vi.fn(async () => mainState),
      dropContext: vi.fn(async () => undefined),
      semanticCausalCall,
      semanticPublishCall,
    } as unknown as WorkspaceVcs;
    const writer = createWorkspaceConfigMainWriter({ workspaceId: WORKSPACE_ID, vcs });
    const authorizingCaller = {
      ...createVerifiedCaller("shell:dev", "shell"),
      executionSession: {
        contextId: "context:paired-shell",
      } as NonNullable<ServiceContext["caller"]["executionSession"]>,
    };
    const ctx = {
      caller: createVerifiedCaller("@workspace-extensions/git-bridge", "extension"),
      authorizingCaller,
      requestId: "request:provider-config",
      authorization: INTERNAL_AUTHORIZATION,
    } satisfies ServiceContext;

    await expect(
      writer.applyMutation({
        ctx,
        mutate: (config) => ({ ...config, defaultRepo: "panels/new" }),
        summary: "record provider remote",
      })
    ).resolves.toMatchObject({ changed: true });

    expect(vcs.ensureSemanticContext).not.toHaveBeenCalled();
    expect(vcs.dropContext).not.toHaveBeenCalled();
    expect(
      semanticCausalCall.mock.calls.find(([method]) => method === "vcsEdit")?.[1]
    ).toMatchObject({ contextId: "context:paired-shell" });
    expect(semanticPublishCall).toHaveBeenCalledWith(
      expect.objectContaining({ contextId: "context:paired-shell" }),
      null,
      authorizingCaller
    );
  });

  it("falls back to an isolated config context rather than publishing dirty caller work", async () => {
    const semanticCausalCall = configReader(`systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\n`);
    semanticCausalCall.mockImplementationOnce(async (_method, input) => ({
      contextId: (input as { contextId: string }).contextId,
      committed: mainState,
      workingHead: editedState,
      clean: false,
      mainEventId: mainState.eventId,
      mainRelation: "at",
      workingCounts: { applications: 1, workUnits: 1, changes: 1 },
    }));
    const ensureSemanticContext = vi.fn(async (_contextId: string) => mainState);
    const vcs = {
      withProtectedMainMutation,
      whenSemanticReady,
      ensureSemanticContext,
      dropContext: vi.fn(async () => undefined),
      semanticCausalCall,
      semanticPublishCall: vi.fn(),
    } as unknown as WorkspaceVcs;
    const writer = createWorkspaceConfigMainWriter({ workspaceId: WORKSPACE_ID, vcs });
    const executionSession = {
      contextId: "context:dirty-agent-task",
    } as unknown as NonNullable<ServiceContext["caller"]["executionSession"]>;
    const ctx = {
      caller: {
        ...createVerifiedCaller("do:eval", "do"),
        executionSession,
      },
      requestId: "request:dirty-config",
      authorization: INTERNAL_AUTHORIZATION,
    } satisfies ServiceContext;

    await expect(
      writer.applyMutation({
        ctx,
        mutate: (config) => ({ ...config, defaultRepo: "panels/new" }),
        summary: "change default repo",
      })
    ).resolves.toMatchObject({ changed: true });
    expect(vcs.ensureSemanticContext).toHaveBeenCalledOnce();
    expect(vcs.dropContext).toHaveBeenCalledOnce();
    const isolatedContextId = ensureSemanticContext.mock.calls[0]?.[0];
    expect(isolatedContextId).toMatch(/^system:workspace-config:/u);
    expect(
      semanticCausalCall.mock.calls.find(
        ([method, input]) =>
          method === "vcsEdit" && (input as { contextId?: string }).contextId === isolatedContextId
      )
    ).toBeDefined();
    expect(vcs.semanticPublishCall).toHaveBeenCalledWith(
      expect.objectContaining({ contextId: isolatedContextId }),
      null,
      ctx.caller
    );
  });

  it("does not author content when rendering is unchanged", async () => {
    const semanticCausalCall = configReader(`systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\n`);
    const vcs = {
      withProtectedMainMutation,
      whenSemanticReady,
      ensureSemanticContext: vi.fn(async () => mainState),
      dropContext: vi.fn(async () => undefined),
      semanticCausalCall,
      semanticPublishCall: vi.fn(),
    } as unknown as WorkspaceVcs;
    const writer = createWorkspaceConfigMainWriter({ workspaceId: WORKSPACE_ID, vcs });

    await expect(writer.wouldMutate((config) => config)).resolves.toBe(false);
    expect(semanticCausalCall.mock.calls.map(([method]) => method)).toEqual([
      "vcsStatus",
      "vcsNeighbors",
      "vcsInspect",
      "vcsListFiles",
      "vcsReadFile",
    ]);
    expect(vcs.dropContext).toHaveBeenCalledOnce();
  });

  it("keeps an operation failure primary when temporary-context cleanup also fails", async () => {
    const operationFailure = Object.assign(new Error("protected publication failed"), {
      code: "EPUBLISH",
      errorKind: "application",
      errorData: { stage: "push" },
    });
    const cleanupFailure = Object.assign(new Error("context cleanup failed"), {
      code: "EACCES",
      errorKind: "access",
      errorData: { authorityFailure: { reasonCode: "missing-grant" } },
    });
    const semanticCausalCall = configReader(`systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\n`);
    const vcs = {
      withProtectedMainMutation,
      whenSemanticReady,
      ensureSemanticContext: vi.fn(async () => mainState),
      dropContext: vi.fn(async () => {
        throw cleanupFailure;
      }),
      semanticCausalCall,
      semanticPublishCall: vi.fn(async () => {
        throw operationFailure;
      }),
    } as unknown as WorkspaceVcs;
    const writer = createWorkspaceConfigMainWriter({ workspaceId: WORKSPACE_ID, vcs });
    const ctx = {
      caller: createVerifiedCaller("shell:dev", "shell"),
      requestId: "request:config-failure",
      authorization: INTERNAL_AUTHORIZATION,
    } satisfies ServiceContext;

    const rejected = await writer
      .applyMutation({
        ctx,
        mutate: (config) => ({ ...config, defaultRepo: "panels/new" }),
        summary: "change default repo",
      })
      .catch((error: unknown) => error);

    expect(rejected).toBe(operationFailure);
    expect(rejected).toMatchObject({
      message: "protected publication failed",
      code: "EPUBLISH",
      errorKind: "application",
      errorData: {
        stage: "push",
        cleanupFailures: [
          {
            stage: "drop-temporary-context",
            contextId: expect.stringMatching(/^system:workspace-config:/),
            message: "context cleanup failed",
            code: "EACCES",
            errorKind: "access",
            errorData: { authorityFailure: { reasonCode: "missing-grant" } },
          },
        ],
      },
    });
  });

  it("rejects a persisted host identity instead of repairing legacy content", () => {
    expect(() =>
      renderWorkspaceConfigYaml(
        `id: stale-checkout-name\nsystemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\n`,
        {
          id: WORKSPACE_ID,
          systemEpoch: WORKSPACE_SYSTEM_EPOCH,
          defaultRepo: "projects/new",
        },
        WORKSPACE_ID
      )
    ).toThrow("`id` is resolved by the host");
  });

  it("keeps the resolved hub identity out of valid manifest content", () => {
    const rendered = renderWorkspaceConfigYaml(
      `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\n`,
      {
        id: WORKSPACE_ID,
        systemEpoch: WORKSPACE_SYSTEM_EPOCH,
        defaultRepo: "projects/new",
      },
      WORKSPACE_ID
    );

    expect(rendered).not.toMatch(/^id:/mu);
    expect(rendered).toContain("defaultRepo: projects/new");
  });

  it("rejects stale, forged, and out-of-scope prepared config mutations before authoring", async () => {
    const initialYaml = `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\n`;
    const semanticCausalCall = configReader(initialYaml);
    const vcs = {
      withProtectedMainMutation,
      whenSemanticReady,
      ensureSemanticContext: vi.fn(async () => mainState),
      dropContext: vi.fn(async () => undefined),
      semanticCausalCall,
      semanticPublishCall: vi.fn(),
    } as unknown as WorkspaceVcs;
    const writer = createWorkspaceConfigMainWriter({ workspaceId: WORKSPACE_ID, vcs });
    const ctx = {
      caller: createVerifiedCaller("shell:dev", "shell"),
      requestId: "request:prepared-config",
      authorization: INTERNAL_AUTHORIZATION,
    } satisfies ServiceContext;
    const current = {
      id: WORKSPACE_ID,
      systemEpoch: WORKSPACE_SYSTEM_EPOCH,
    };
    const next = { ...current, defaultRepo: "projects/new" };

    await expect(
      writer.applyPrepared({
        ctx,
        expectedBaseDigest: "v1-sha256:".padEnd(74, "0"),
        nextState: next,
        resultDigest: workspaceConfigDigest(next),
        allowedPathScope: ["defaultRepo"],
        summary: "stale mutation",
      })
    ).rejects.toThrow(/base is stale/);

    await expect(
      writer.applyPrepared({
        ctx,
        expectedBaseDigest: workspaceConfigDigest(current),
        nextState: next,
        resultDigest: "v1-sha256:".padEnd(74, "f"),
        allowedPathScope: ["defaultRepo"],
        summary: "forged mutation",
      })
    ).rejects.toThrow(/result digest mismatch/);

    await expect(
      writer.applyPrepared({
        ctx,
        expectedBaseDigest: workspaceConfigDigest(current),
        nextState: next,
        resultDigest: workspaceConfigDigest(next),
        allowedPathScope: ["git.remotes"],
        summary: "scope escape",
      })
    ).rejects.toThrow(/defaultRepo outside its allowed scope/);

    expect(semanticCausalCall.mock.calls.map(([method]) => method)).not.toContain("vcsEdit");
    expect(vcs.semanticPublishCall).not.toHaveBeenCalled();
  });
});

it("preserves composed settings while adding a workspace declaration", async () => {
  const { parseWorkspaceConfigContentWithId } = await import("@vibestudio/workspace/configParser");
  const dependency = {
    systemEpoch: WORKSPACE_SYSTEM_EPOCH,
    extensions: [{ source: "extensions/inherited" }],
    defaultAgentConfig: { model: "inherited-model" },
    template: {},
  };
  const pin = {
    url: "https://example.test/base.git",
    ref: "refs/heads/main",
    commit: "a".repeat(40),
  };
  const source = YAML.stringify({
    ...dependency,
    template: {
      dependencies: [{ url: pin.url }],
    },
  });
  const before = parseWorkspaceConfigContentWithId(source, "workspace");
  const next = {
    ...before,
    extensions: [...before.extensions!, { source: "extensions/mine" }],
    defaultAgentConfig: { ...before.defaultAgentConfig, thinkingLevel: "high" },
  };
  const rendered = renderWorkspaceConfigYaml(source, next, "workspace");
  const authored = YAML.parse(rendered);
  expect(authored.extensions).toEqual(next.extensions);
  expect(authored.defaultAgentConfig).toEqual({ model: "inherited-model", thinkingLevel: "high" });
  expect(authored.template).toEqual(YAML.parse(source).template);
  expect(parseWorkspaceConfigContentWithId(rendered, "workspace").extensions).toEqual(
    next.extensions
  );
});
