import { describe, expect, it, vi } from "vitest";
import { createNativeDevelopmentSemanticAdapter } from "./nativeDevelopmentSemanticAdapter.js";
import type { NativeSnapshotDescriptor } from "./nativeDevelopmentExecutor.js";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { vcsImportSnapshotResultSchema } from "@vibestudio/service-schemas/vcs";

const descriptor: NativeSnapshotDescriptor = {
  version: 1,
  repositoryId: "repository:vibestudio",
  repoPath: "projects/vibestudio",
  source: {
    kind: "filesystem",
    uri: "vibestudio-development://session/session-1",
    snapshotRevision: "snapshot-revision-1",
  },
  files: [{ path: "src/index.ts", contentHash: "a".repeat(64), mode: 0o640 }],
  descriptorDigest: "b".repeat(64),
};
const access = { caller: createVerifiedCaller("shell:owner", "shell"), ownerContextId: "context:owner" };
const ingress = {
  access,
  uploadPrincipal: "verified-upload",
  causalParent: {
    kind: "trajectory-invocation" as const,
    invocationId: "invocation:development-checkpoint",
    logId: "trajectory:development",
    head: "head:development",
  },
};

describe("createNativeDevelopmentSemanticAdapter", () => {
  it("commits a dirty child base through the verified causal ingress", async () => {
    const saveParticipantContextFromAccess = vi.fn(async () => ({
      contextId: "context:child",
      event: { kind: "event" as const, eventId: "event:base" },
      committedApplicationIds: ["application:dirty"],
      integrationSourceEventIds: [],
    }));
    const adapter = createNativeDevelopmentSemanticAdapter({ saveParticipantContextFromAccess, importParticipantSnapshotFromContext: vi.fn() });

    const event = await adapter.commitChildBase({
      developmentContextId: "context:child",
      expectedWorkingHead: {
        kind: "application",
        applicationId: "application:dirty",
      },
      commandId: "command:base",
      message: "Development session base session-1",
      ingress,
    });

    expect(event).toEqual({ kind: "event", eventId: "event:base" });
    expect(saveParticipantContextFromAccess).toHaveBeenCalledWith({
      access,
      cause: { parent: ingress.causalParent },
      commit: expect.objectContaining({
        contextId: "context:child",
        commandId: "command:base",
        expectedWorkingHead: { kind: "application", applicationId: "application:dirty" },
      }),
    });
  });

  it("does not mint an empty commit when the inherited child is already clean", async () => {
    const saveParticipantContextFromAccess = vi.fn();
    const adapter = createNativeDevelopmentSemanticAdapter({ saveParticipantContextFromAccess, importParticipantSnapshotFromContext: vi.fn() });
    const clean = { kind: "event", eventId: "event:already-clean" } as const;
    await expect(
      adapter.commitChildBase({
        developmentContextId: "context:child",
        expectedWorkingHead: clean,
        commandId: "command:base",
        message: "Development session base session-1",
        ingress,
      })
    ).resolves.toEqual(clean);
    expect(saveParticipantContextFromAccess).not.toHaveBeenCalled();
  });

  it("imports the exact repository in the admitted participant history", async () => {
    const receipt = vcsImportSnapshotResultSchema.parse({
      contextId: "context:child",
      eventId: "event:checkpoint",
      workUnitId: "work-unit:checkpoint",
      applicationId: "application:checkpoint",
      externalSnapshot: {
        sourceKind: "filesystem",
        sourceUri: descriptor.source.uri,
        snapshotRevision: descriptor.source.snapshotRevision,
        snapshotDigest: `snapshot:${"c".repeat(64)}`,
        targetRepositoryIds: ["repository:vibestudio"],
      },
      importedRepositoryIds: ["repository:vibestudio"],
    });
    const importParticipantSnapshotFromContext = vi.fn(async () => receipt);
    const adapter = createNativeDevelopmentSemanticAdapter({
      saveParticipantContextFromAccess: vi.fn(), importParticipantSnapshotFromContext,
    });

    const result = await adapter.importSnapshot({
      developmentContextId: "context:child",
      repositoryId: "repository:vibestudio",
      expectedWorkingHead: { kind: "event", eventId: "event:base" },
      commandId: "command:checkpoint",
      descriptor,
      ingress,
    });

    expect(result.eventId).toBe("event:checkpoint");
    const expected = {
        contextId: "context:child",
        commandId: "command:checkpoint",
        expectedWorkingHead: { kind: "event", eventId: "event:base" },
        intentSummary: "Import one explicit native development checkpoint",
        source: descriptor.source,
        repositories: [
          {
            repositoryId: "repository:vibestudio",
            repoPath: "projects/vibestudio",
            files: descriptor.files,
          },
        ],
        message: "Native development checkpoint snapshot-revision-1",
    };
    expect(importParticipantSnapshotFromContext).toHaveBeenCalledWith({
      access, uploadPrincipal: ingress.uploadPrincipal, snapshot: expected,
      cause: { parent: ingress.causalParent },
    });
  });

  it("rejects repository substitution before semantic mutation", async () => {
    const importParticipantSnapshotFromContext = vi.fn();
    const adapter = createNativeDevelopmentSemanticAdapter({
      saveParticipantContextFromAccess: vi.fn(), importParticipantSnapshotFromContext,
    });
    await expect(
      adapter.importSnapshot({
        developmentContextId: "context:child",
        repositoryId: "repository:other",
        expectedWorkingHead: { kind: "event", eventId: "event:base" },
        commandId: "command:checkpoint",
        descriptor,
        ingress,
      })
    ).rejects.toMatchObject({ code: "EIDENTITYDRIFT" });
    expect(importParticipantSnapshotFromContext).not.toHaveBeenCalled();
  });

  it("rejects noncanonical or credential-bearing source identities before semantic mutation", async () => {
    const importParticipantSnapshotFromContext = vi.fn();
    const adapter = createNativeDevelopmentSemanticAdapter({
      saveParticipantContextFromAccess: vi.fn(), importParticipantSnapshotFromContext,
    });
    await expect(
      adapter.importSnapshot({
        developmentContextId: "context:child",
        repositoryId: "repository:vibestudio",
        expectedWorkingHead: { kind: "event", eventId: "event:base" },
        commandId: "command:checkpoint",
        descriptor: {
          ...descriptor,
          source: {
            ...descriptor.source,
            uri: "https://user:secret@example.invalid/native-tree",
          },
        },
        ingress,
      })
    ).rejects.toMatchObject({ code: "EINTEGRITY" });
    expect(importParticipantSnapshotFromContext).not.toHaveBeenCalled();
  });
});
