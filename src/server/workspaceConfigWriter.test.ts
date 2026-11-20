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
function configFixture(initialYaml: string) {
  const author = createHostCaller("server", "server", { userId: "system", handle: "system" });
  const canonical = { source: "workers/workspace-source", className: "GadHistoryDO", objectKey: "canonical" };
  const content = { kind: "text" as const, text: initialYaml };
  const openParticipantScope = vi.fn<WorkspaceVcs["openParticipantScope"]>(async ({ contextId, caller }) => ({
    caller, contextId, ownerContextId: contextId, canonical, workingHead: "native-main",
    owner: { ...canonical, objectKey: `work-${sha256HexSyncText(workspaceParticipantIdentity(caller, contextId))}` },
    dispatch: {
      async dispatch(_target, method) {
        if (method === "readHistoryStatus") return {
          contextId, committed: mainState, workingHead: mainState, clean: true,
          mainEventId: mainState.eventId, mainRelation: "at",
          workingCounts: { applications: 0, workUnits: 0, changes: 0 },
        };
        if (method === "resolveHistoryRepository")
          return { state: mainState, repositoryId: "repository:meta", repoPath: "meta" };
        throw new Error(`Unexpected native history call ${method}`);
      },
    },
  }));
  const vcs = {
    whenSemanticReady: vi.fn<WorkspaceVcs["whenSemanticReady"]>(async () => {}),
    withProtectedMainMutation: <T>(operation: () => Promise<T>): Promise<T> => operation(),
    openParticipantScope,
    dropContext: vi.fn<WorkspaceVcs["dropContext"]>(async () => {}),
    ensureFresh: vi.fn<WorkspaceVcs["ensureFresh"]>(async () => ({ stateHash: "state:protected" })),
    readFile: vi.fn<WorkspaceVcs["readFile"]>(async () => ({
      content, stateHash: "state:protected", contentHash: "blob:before", mode: 0o644,
      size: Buffer.byteLength(initialYaml),
    })),
    readParticipantFiles: vi.fn<WorkspaceVcs["readParticipantFiles"]>(async () => [{
      repositoryId: "repository:meta", fileId: "file:config", repoPath: "meta",
      path: "vibestudio.yml", contentHash: "blob:before", mode: 0o644, content,
      authoredChangeId: null, authoredByWorkUnitId: null, contentClass: "internal", externalKeys: [],
    }]),
    editParticipantContext: vi.fn<WorkspaceVcs["editParticipantContext"]>(async ({ edit }) => ({
      head: "native-edited",
      result: {
        contextId: edit.contextId, commandId: edit.commandId, workUnitId: "work-unit:config",
        applicationId: editedState.applicationId, workingHead: editedState,
        changeCount: 1, changeIds: ["change:config"], incorporatedChangeCount: 0,
        incorporatedChangeIds: [], decisionIds: [],
      },
    })),
    saveParticipantContext: vi.fn<WorkspaceVcs["saveParticipantContext"]>(async ({ commit }) => ({
      contextId: commit.contextId, event: committedState,
      committedApplicationIds: [editedState.applicationId], integrationSourceEventIds: [],
    })),
    publishParticipantContext: vi.fn<WorkspaceVcs["publishParticipantContext"]>(async ({ push }) => ({
      contextId: push.contextId, effectId: "effect:config", appliedAt: 1,
      eventId: committedState.eventId, mainEventId: committedState.eventId,
    })),
  };
  return { author, vcs, writer: createWorkspaceConfigMainWriter({ workspaceId: WORKSPACE_ID, vcs, authoringCaller: author }) };
}

describe("workspaceConfigWriter", () => {
  it("authors settings in a temporary participant copy and preserves the approving caller", async () => {
    const { author, writer, vcs } = configFixture(
      `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\ndefaultRepo: panels/old\n`
    );
    const approver = createVerifiedCaller("shell:owner", "shell");
    const { openParticipantScope, editParticipantContext, saveParticipantContext, publishParticipantContext, dropContext } = vcs;
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
  });

  it("does not author content when rendering is unchanged", async () => {
    const { writer, vcs } = configFixture(`systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\n`);

    await expect(writer.wouldMutate((config) => config)).resolves.toBe(false);
    expect(vcs.openParticipantScope).not.toHaveBeenCalled();
    await expect(writer.applyMutation({
      ctx: { caller: createVerifiedCaller("shell:dev", "shell") },
      mutate: (config) => config,
      summary: "unchanged settings",
    })).resolves.toMatchObject({ changed: false });
    expect(vcs.editParticipantContext).not.toHaveBeenCalled();
    expect(vcs.publishParticipantContext).not.toHaveBeenCalled();
    const contextId = vcs.openParticipantScope.mock.calls[0]![0].contextId;
    expect(vcs.dropContext).toHaveBeenCalledExactlyOnceWith(contextId);
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
    const { writer, vcs } = configFixture(`systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\n`);
    vcs.dropContext.mockRejectedValueOnce(cleanupFailure);
    vcs.publishParticipantContext.mockRejectedValueOnce(operationFailure);
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
    const { writer, vcs } = configFixture(`systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\n`);
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

    expect(vcs.editParticipantContext).not.toHaveBeenCalled();
    expect(vcs.publishParticipantContext).not.toHaveBeenCalled();
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
