import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import type { WorkspaceVcs } from "./vcsHost/workspaceVcs.js";
import { createWorkspaceConfigMainWriter } from "./workspaceConfigWriter.js";

const mainState = { kind: "event" as const, eventId: "event:main" };
const editedState = { kind: "application" as const, applicationId: "application:config" };
const committedState = { kind: "event" as const, eventId: "event:config" };
const repositoryRef = {
  kind: "repository" as const,
  state: mainState,
  repositoryId: "repository:meta",
};

function configReader(initialYaml: string) {
  return vi.fn(async (method: string, input: unknown) => {
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
        integrationSourceEventId: null,
      };
    }
    throw new Error(`unexpected semantic call ${method}`);
  });
}

describe("workspaceConfigWriter", () => {
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
    const vcs = {
      ensureContext: vi.fn(async () => mainState),
      dropContext: vi.fn(async () => undefined),
      semanticCausalCall,
      semanticPublishCall,
    } as unknown as WorkspaceVcs;
    const writer = createWorkspaceConfigMainWriter({ workspacePath: "/workspace", vcs });
    const ctx = {
      caller: createVerifiedCaller("shell:dev", "shell"),
      requestId: "request:config",
    };

    const result = await writer.applyMutation({
      ctx,
      mutate: (config) => ({ ...config, defaultRepo: "panels/new" }),
      summary: "change default repo",
    });

    expect(result).toMatchObject({ changed: true, nextConfig: { defaultRepo: "panels/new" } });
    const contextId = vi.mocked(vcs.ensureContext).mock.calls[0]?.[0];
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

  it("does not author content when rendering is unchanged", async () => {
    const semanticCausalCall = configReader(`systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\n`);
    const vcs = {
      ensureContext: vi.fn(async () => mainState),
      dropContext: vi.fn(async () => undefined),
      semanticCausalCall,
      semanticPublishCall: vi.fn(),
    } as unknown as WorkspaceVcs;
    const writer = createWorkspaceConfigMainWriter({ workspacePath: "/workspace", vcs });

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
});
