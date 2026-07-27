import { describe, expect, it, vi } from "vitest";
import { createNativeDevelopmentSemanticAdapter } from "./nativeDevelopmentSemanticAdapter.js";
import type { NativeSnapshotDescriptor } from "./nativeDevelopmentExecutor.js";

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
const ingress = {
  causalParent: {
    kind: "trajectory-invocation" as const,
    invocationId: "invocation:development-checkpoint",
    logId: "trajectory:development",
    head: "head:development",
  },
  contextIntegrity: {
    class: "external" as const,
    externalKeys: ["upstream:file"],
  },
};

describe("createNativeDevelopmentSemanticAdapter", () => {
  it("commits a dirty child base through the verified causal ingress", async () => {
    const semanticCausalCall = vi.fn(async () => ({
      contextId: "context:child",
      event: { kind: "event", eventId: "event:base" },
      committedApplicationIds: ["application:dirty"],
      integrationSourceEventIds: [],
    }));
    const adapter = createNativeDevelopmentSemanticAdapter({ semanticCausalCall });

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
    expect(semanticCausalCall).toHaveBeenCalledWith(
      "vcsCommit",
      expect.objectContaining({
        contextId: "context:child",
        commandId: "command:base",
        expectedWorkingHead: {
          kind: "application",
          applicationId: "application:dirty",
        },
      }),
      ingress.causalParent,
      ingress.contextIntegrity
    );
  });

  it("does not mint an empty commit when the inherited child is already clean", async () => {
    const semanticCausalCall = vi.fn();
    const adapter = createNativeDevelopmentSemanticAdapter({ semanticCausalCall });
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
    expect(semanticCausalCall).not.toHaveBeenCalled();
  });

  it("imports the exact existing repository and marks the filesystem descriptor external", async () => {
    const semanticCausalCall = vi.fn(async () => ({
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
    }));
    const adapter = createNativeDevelopmentSemanticAdapter({ semanticCausalCall });

    const result = await adapter.importSnapshot({
      developmentContextId: "context:child",
      repositoryId: "repository:vibestudio",
      expectedWorkingHead: { kind: "event", eventId: "event:base" },
      commandId: "command:checkpoint",
      descriptor,
      ingress,
    });

    expect(result.eventId).toBe("event:checkpoint");
    expect(semanticCausalCall).toHaveBeenCalledWith(
      "vcsImportSnapshot",
      {
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
      },
      ingress.causalParent,
      {
        class: "external",
        externalKeys: [
          `native-development-snapshot:${descriptor.descriptorDigest}`,
          "upstream:file",
        ],
      }
    );
  });

  it("rejects repository substitution before semantic mutation", async () => {
    const semanticCausalCall = vi.fn();
    const adapter = createNativeDevelopmentSemanticAdapter({ semanticCausalCall });
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
    expect(semanticCausalCall).not.toHaveBeenCalled();
  });

  it("rejects noncanonical or credential-bearing source identities before semantic mutation", async () => {
    const semanticCausalCall = vi.fn();
    const adapter = createNativeDevelopmentSemanticAdapter({ semanticCausalCall });
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
    expect(semanticCausalCall).not.toHaveBeenCalled();
  });
});
