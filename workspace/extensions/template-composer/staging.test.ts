import { describe, expect, it, vi } from "vitest";
import type { VcsStateNodeRef } from "@vibestudio/service-schemas/vcs";
import { semanticRepositoryDigest } from "./semanticRepository.js";
import { acquireTemplateSnapshot } from "./source.js";

vi.mock("./source.js", () => ({
  acquireTemplateSnapshot: vi.fn(async () => ({
    files: [
      {
        path: "panels/one/index.ts",
        contentHash: "1".repeat(64),
        size: 1,
        mode: 0o644,
      },
      {
        path: "panels/two/index.ts",
        contentHash: "2".repeat(64),
        size: 1,
        mode: 0o644,
      },
    ],
  })),
}));

import {
  clearTemplateOperationRecordFile,
  createTemplateOperationPorts,
  isTemplateOperationCancelled,
  mergeTemplateContributions,
  readTemplateOperationRecord,
  TemplateOperationMainAdvanced,
  TemplateReviewRequired,
  updateTemplateOperationRecord,
} from "./staging.js";

const BASE = { kind: "event", eventId: "event-base" } as const;
const OLD_ONE = "1".repeat(64);
const OLD_TWO = "2".repeat(64);
const NEW_ONE = "3".repeat(64);
const NEW_TWO = "4".repeat(64);

describe("template composer staging", () => {
  it("observes a missing operation without creating its context", async () => {
    const call = vi.fn(async (_target: string, method: string) => {
      if (method === "runtime.listContexts") return { contexts: [] };
      throw new Error(`unexpected RPC ${method}`);
    });

    await expect(
      readTemplateOperationRecord({ rpc: { call } } as never, "operation-missing")
    ).resolves.toBeNull();
    expect(call).not.toHaveBeenCalledWith("main", "runtime.createContext", expect.anything());
  });

  it("reads a durable cancellation from the exact protected-main event", async () => {
    const call = vi.fn(async (_target: string, method: string, input: Record<string, unknown>) => {
      if (method === "vcs.resolveRepository") {
        expect(input["state"]).toEqual({ kind: "event", eventId: "event:cancelled" });
        return { repositoryId: "repository:meta", repoPath: "meta" };
      }
      if (method === "vcs.readFile") {
        return {
          content: {
            kind: "text",
            text: `${JSON.stringify({ version: 1, operationId: "pull-1" })}\n`,
          },
        };
      }
      throw new Error(`unexpected RPC ${method}`);
    });

    await expect(
      isTemplateOperationCancelled({ rpc: { call } } as never, "event:cancelled", "pull-1")
    ).resolves.toBe(true);
  });

  it("recreates repair state after metadata staging removed the temporary record", async () => {
    const call = vi.fn(async (_target: string, method: string) => {
      if (method === "runtime.createContext") return {};
      if (method === "vcs.status") {
        return { committed: BASE, workingHead: BASE, clean: true };
      }
      if (method === "vcs.resolveRepository") {
        return { repositoryId: "repository:meta", repoPath: "meta" };
      }
      if (method === "vcs.readFile") return null;
      if (method === "vcs.edit" || method === "vcs.commit") return {};
      throw new Error(`unexpected RPC ${method}`);
    });
    const record = {
      version: 1 as const,
      operationId: "repair-news",
      kind: "pull" as const,
      fingerprint: `v1-sha256:${"a".repeat(64)}`,
      intent: { kind: "pull" },
      pins: [],
      affectedParts: ["panels/news"],
      preparedAffectedRepoPaths: ["panels/news"],
      buildFailures: [{ unit: "panels/news", message: "type error" }],
    };

    await updateTemplateOperationRecord({ rpc: { call } } as never, record);

    expect(call).toHaveBeenCalledWith(
      "main",
      "vcs.edit",
      expect.objectContaining({
        changes: [
          expect.objectContaining({ kind: "file-create", path: "template-operations/record.json" }),
        ],
      })
    );
  });

  it("treats an already-persisted repair record as an idempotent retry", async () => {
    const record = {
      version: 1 as const,
      operationId: "repair-news",
      kind: "pull" as const,
      fingerprint: `v1-sha256:${"a".repeat(64)}`,
      intent: { kind: "pull" },
      pins: [],
      affectedParts: ["panels/news"],
      buildFailures: [{ unit: "panels/news", message: "type error" }],
    };
    const call = vi.fn(async (_target: string, method: string) => {
      if (method === "runtime.createContext") return {};
      if (method === "vcs.status") return { committed: BASE, workingHead: BASE, clean: true };
      if (method === "vcs.resolveRepository") {
        return { repositoryId: "repository:meta", repoPath: "meta" };
      }
      if (method === "vcs.readFile") {
        return {
          fileId: "file:record",
          content: { kind: "text", text: `${JSON.stringify(record, null, 2)}\n` },
        };
      }
      throw new Error(`unexpected RPC ${method}`);
    });

    await updateTemplateOperationRecord({ rpc: { call } } as never, record);

    expect(call).not.toHaveBeenCalledWith("main", "vcs.edit", expect.anything());
    expect(call).not.toHaveBeenCalledWith("main", "vcs.commit", expect.anything());
  });

  it("removes temporary repair state before publishing the repaired context", async () => {
    const record = {
      version: 1 as const,
      operationId: "repair-news",
      kind: "pull" as const,
      fingerprint: `v1-sha256:${"a".repeat(64)}`,
      intent: { kind: "pull", alias: "news" },
      pins: [],
      affectedParts: ["panels/news"],
      preparedAffectedRepoPaths: ["panels/news"],
    };
    const call = vi.fn(async (_target: string, method: string) => {
      if (method === "runtime.createContext") return {};
      if (method === "vcs.status") {
        return { committed: BASE, workingHead: BASE, clean: true };
      }
      if (method === "vcs.resolveRepository") {
        return { repositoryId: "repository:meta", repoPath: "meta" };
      }
      if (method === "vcs.readFile")
        return { fileId: "file:record", content: { kind: "text", text: "{}" } };
      if (method === "vcs.edit" || method === "vcs.commit") return {};
      throw new Error(`unexpected RPC ${method}`);
    });

    await clearTemplateOperationRecordFile({ rpc: { call } } as never, record);

    expect(call).toHaveBeenCalledWith(
      "main",
      "vcs.edit",
      expect.objectContaining({
        changes: [expect.objectContaining({ kind: "file-delete", fileId: "file:record" })],
      })
    );
    expect(call).toHaveBeenCalledWith(
      "main",
      "vcs.commit",
      expect.objectContaining({ message: expect.stringMatching(/^template-composer-intent:v1:/u) })
    );
  });

  it("returns an actionable stale-main error when reopening an operation context", async () => {
    const call = vi.fn(async (_target: string, method: string) => {
      if (method === "runtime.createContext") return {};
      if (method === "vcs.status") {
        return {
          committed: BASE,
          workingHead: BASE,
          clean: true,
          mainRelation: "behind",
          mainEventId: "event:new-main",
        };
      }
      throw new Error(`unexpected RPC ${method}`);
    });
    const ports = createTemplateOperationPorts({ rpc: { call } } as never, "/state", {
      localRepoPaths: [],
    } as never);

    await expect(ports.openContext("pull-news")).rejects.toMatchObject({
      name: "TemplateOperationMainAdvanced",
      contextId: expect.stringMatching(/^template-composer-operation-/u),
      mainEventId: "event:new-main",
      relation: "behind",
    } satisfies Partial<TemplateOperationMainAdvanced>);
  });

  it("returns an actionable stale-main error when main advances before publication", async () => {
    const call = vi.fn(async (_target: string, method: string) => {
      if (method === "vcs.status") {
        return {
          committed: BASE,
          workingHead: BASE,
          clean: true,
          mainRelation: "diverged",
          mainEventId: "event:new-main",
        };
      }
      throw new Error(`unexpected RPC ${method}`);
    });
    const ports = createTemplateOperationPorts({ rpc: { call } } as never, "/state", {
      localRepoPaths: [],
    } as never);

    await expect(ports.publish("operation-context", "event:old-main")).rejects.toMatchObject({
      name: "TemplateOperationMainAdvanced",
      contextId: "operation-context",
      mainEventId: "event:new-main",
      relation: "diverged",
    } satisfies Partial<TemplateOperationMainAdvanced>);
    expect(call).not.toHaveBeenCalledWith("main", "vcs.push", expect.anything());
  });

  it("records adopted lineage metadata without replaying repository contributions", async () => {
    const call = vi.fn(async (_target: string, method: string) => {
      if (method === "vcs.status") {
        return {
          committed: BASE,
          workingHead: BASE,
          clean: true,
          mainRelation: "at",
          mainEventId: BASE.eventId,
        };
      }
      if (method === "vcs.resolveRepository") {
        return { repositoryId: "repository:meta", repoPath: "meta" };
      }
      if (method === "vcs.readFile") return null;
      if (method === "vcs.edit") return {};
      throw new Error(`unexpected RPC ${method}`);
    });
    const ports = createTemplateOperationPorts({ rpc: { call } } as never, "/state", {
      workspaceId: "workspace-1",
      top: { systemEpoch: 57, templates: { use: [] } },
      runtimeTop: { systemEpoch: 57 },
      localRepoPaths: new Set(["packages/runtime"]),
    } as never);
    const pin = {
      url: "git+https://example.test/base.git",
      ref: "refs/tags/v1",
      commit: "1".repeat(40),
      snapshot: `v1-sha256:${"1".repeat(64)}`,
    };
    const result = await ports.stageComposition("operation-adopt", {
      kind: "adopt",
      nextTemplates: { use: [{ url: pin.url }], overrides: {} },
      plan: {
        fingerprint: `v1-sha256:${"2".repeat(64)}`,
        rootNodeIds: ["t-base"],
        nodes: [
          {
            nodeId: "t-base",
            alias: "base",
            pin,
            parents: [],
            fragment: { systemEpoch: 57 },
          },
        ],
        repositories: {
          "packages/runtime": {
            repoPath: "packages/runtime",
            contributions: [],
          },
        },
        localRepoPaths: ["packages/runtime"],
        artifacts: [],
        removedArtifactPaths: [],
        lock: {} as never,
      },
    } as never);

    expect(result).toEqual({ affectedRepoPaths: ["packages/runtime"] });
    expect(call).toHaveBeenCalledWith(
      "main",
      "vcs.edit",
      expect.objectContaining({ intentSummary: "Update generated template composition metadata" })
    );
    expect(call).not.toHaveBeenCalledWith("main", "vcs.registerExternalDelta", expect.anything());
    expect(call).not.toHaveBeenCalledWith("main", "vcs.importSnapshot", expect.anything());
    expect(call).not.toHaveBeenCalledWith("main", "vcs.merge", expect.anything());
  });

  it("surfaces an overlapping contribution as an ordinary VCS review delta", async () => {
    let imported = false;
    let reviewComplete = false;
    const call = vi.fn(async (_target: string, method: string, input: Record<string, unknown>) => {
      if (method === "vcs.status") {
        return { committed: BASE, workingHead: BASE, clean: true };
      }
      if (method === "vcs.resolveRepository") {
        return imported
          ? { repositoryId: "repository:runtime", repoPath: "packages/runtime" }
          : null;
      }
      if (method === "vcs.importSnapshot") {
        imported = true;
        return {
          eventId: "event-import-runtime",
          importedRepositoryIds: ["repository:runtime"],
        };
      }
      if (method === "vcs.registerExternalDelta") return { deltaId: "delta:overlay" };
      if (method === "vcs.compare") {
        return { resolution: { complete: reviewComplete, concluded: reviewComplete } };
      }
      if (method === "vcs.finalizeExternalDelta") return {};
      throw new Error(`unexpected RPC ${method}: ${JSON.stringify(input)}`);
    });
    const contribution = (nodeId: string, alias: string, digit: string) => ({
      nodeId,
      alias,
      subdir: "packages/runtime",
      subtreeDigest: `v1-sha256:${digit.repeat(64)}`,
      files: [{ path: "index.ts", contentHash: digit.repeat(64), size: 1, mode: 0o644 }],
    });
    const plan = {
      nodes: [
        {
          nodeId: "t-base",
          pin: {
            url: "git+https://example.test/base.git",
            ref: "refs/tags/v1",
            commit: "1".repeat(40),
            snapshot: `v1-sha256:${"1".repeat(64)}`,
          },
        },
        {
          nodeId: "t-feature",
          pin: {
            url: "git+https://example.test/feature.git",
            ref: "refs/tags/v1",
            commit: "2".repeat(40),
            snapshot: `v1-sha256:${"2".repeat(64)}`,
          },
        },
      ],
      repositories: {
        "packages/runtime": {
          repoPath: "packages/runtime",
          contributions: [
            contribution("t-base", "base", "1"),
            contribution("t-feature", "feature", "2"),
          ],
        },
      },
    };

    await expect(
      mergeTemplateContributions(
        { rpc: { call } } as never,
        "/state",
        "operation-overlay",
        plan as never,
        undefined
      )
    ).rejects.toMatchObject({
      name: "TemplateReviewRequired",
      contextId: "operation-overlay",
      items: [{ repoPath: "packages/runtime", sourceDeltaId: "delta:overlay" }],
      deltaBasis: BASE,
    } satisfies Partial<TemplateReviewRequired>);
    expect(call).toHaveBeenCalledWith(
      "main",
      "vcs.registerExternalDelta",
      expect.objectContaining({
        repoPath: "packages/runtime",
        oldFiles: [],
        newFiles: [expect.objectContaining({ path: "index.ts" })],
      })
    );
    expect(call).not.toHaveBeenCalledWith("main", "vcs.finalizeExternalDelta", expect.anything());

    const registrations = call.mock.calls.filter(
      ([, method]) => method === "vcs.registerExternalDelta"
    );
    reviewComplete = true;
    await expect(
      mergeTemplateContributions(
        { rpc: { call } } as never,
        "/state",
        "operation-overlay",
        plan as never,
        undefined,
        {
          reviews: [{ repoPath: "packages/runtime", sourceDeltaId: "delta:overlay" }],
          deltaBasis: BASE,
        } as never
      )
    ).resolves.toEqual(["packages/runtime"]);
    expect(call.mock.calls.filter(([, method]) => method === "vcs.registerExternalDelta")).toEqual(
      registrations
    );
    expect(call).toHaveBeenCalledWith(
      "main",
      "vcs.finalizeExternalDelta",
      expect.objectContaining({ deltaId: "delta:overlay" })
    );
  });

  it("gives each resumed review commit an identity derived from its exact state", async () => {
    let workingHead: { kind: "event"; eventId: string } = {
      kind: "event",
      eventId: "event-review-one",
    };
    let clean = false;
    const call = vi.fn(async (_target: string, method: string, input: Record<string, unknown>) => {
      if (method === "vcs.status") {
        return { committed: BASE, workingHead, clean };
      }
      if (method === "vcs.compare") {
        return { resolution: { complete: true, concluded: true } };
      }
      if (method === "vcs.commit") {
        clean = true;
        return {};
      }
      if (method === "vcs.finalizeExternalDelta") return {};
      throw new Error(`unexpected RPC ${method}: ${JSON.stringify(input)}`);
    });
    const plan = { repositories: {} } as never;
    const record = (repoPath: string, sourceDeltaId: string) =>
      ({
        reviews: [{ repoPath, sourceDeltaId }],
        deltaBasis: BASE,
      }) as never;

    await mergeTemplateContributions(
      { rpc: { call } } as never,
      "/state",
      "operation-multi-review",
      plan,
      undefined,
      record("packages/one", "delta:one")
    );
    workingHead = { kind: "event", eventId: "event-review-two" };
    clean = false;
    await mergeTemplateContributions(
      { rpc: { call } } as never,
      "/state",
      "operation-multi-review",
      plan,
      undefined,
      record("packages/two", "delta:two")
    );

    const commitIds = call.mock.calls
      .filter(([, method]) => method === "vcs.commit")
      .map(([, , input]) => (input as { commandId: string }).commandId);
    expect(commitIds).toHaveLength(2);
    expect(new Set(commitIds).size).toBe(2);
    expect(commitIds).toEqual([
      expect.stringMatching(/^operation-multi-review:commit-reviewed-deltas:[a-f0-9]{64}$/),
      expect.stringMatching(/^operation-multi-review:commit-reviewed-deltas:[a-f0-9]{64}$/),
    ]);
  });

  it("seeds an absent repository from acquired files instead of ledger-only lineage", async () => {
    vi.mocked(acquireTemplateSnapshot).mockClear();
    let imported = false;
    const call = vi.fn(async (_target: string, method: string, input: Record<string, unknown>) => {
      if (method === "vcs.status") return { committed: BASE, workingHead: BASE, clean: true };
      if (method === "vcs.resolveRepository") {
        return imported ? { repositoryId: "repository:one", repoPath: "panels/one" } : null;
      }
      if (method === "vcs.importSnapshot") {
        imported = true;
        return {
          eventId: "event-import-one",
          importedRepositoryIds: ["repository:one"],
        };
      }
      throw new Error(`unexpected RPC ${method}: ${JSON.stringify(input)}`);
    });
    const basePin = {
      url: "git+https://example.test/base.git",
      ref: "refs/tags/v1",
      commit: "1".repeat(40),
      snapshot: `v1-sha256:${"a".repeat(64)}`,
    };
    const featurePin = {
      url: "git+https://example.test/feature.git",
      ref: "refs/tags/v1",
      commit: "2".repeat(40),
      snapshot: `v1-sha256:${"b".repeat(64)}`,
    };
    const baseDigest = semanticRepositoryDigest([
      { path: "index.ts", contentHash: OLD_ONE, mode: 0o644, byteLength: 1 },
    ]);
    const featureDigest = semanticRepositoryDigest([
      { path: "feature.ts", contentHash: NEW_ONE, mode: 0o644, byteLength: 1 },
    ]);
    const previous = {
      nodes: [{ nodeId: "t-base", alias: "base", pin: basePin }],
      repositories: {
        "panels/one": {
          contributions: [{ nodeId: "t-base", subtreeDigest: baseDigest }],
        },
      },
    };
    const plan = {
      nodes: [
        { nodeId: "t-base", pin: basePin },
        { nodeId: "t-feature", pin: featurePin },
      ],
      repositories: {
        "panels/one": {
          repoPath: "panels/one",
          contributions: [
            {
              nodeId: "t-base",
              alias: "base",
              subdir: "panels/one",
              subtreeDigest: baseDigest,
              files: [],
            },
            {
              nodeId: "t-feature",
              alias: "feature",
              subdir: "panels/one",
              subtreeDigest: featureDigest,
              files: [{ path: "feature.ts", contentHash: NEW_ONE, size: 1, mode: 0o644 }],
            },
          ],
        },
      },
    };

    await expect(
      mergeTemplateContributions(
        { rpc: { call } } as never,
        "/state",
        "operation-ledger-seed",
        plan as never,
        previous as never
      )
    ).resolves.toEqual(["panels/one"]);
    expect(call).toHaveBeenCalledWith(
      "main",
      "vcs.importSnapshot",
      expect.objectContaining({
        intentSummary: "Import panels/one contribution from feature",
        repositories: [
          {
            repoPath: "panels/one",
            files: [expect.objectContaining({ path: "feature.ts" })],
          },
        ],
      })
    );
    expect(call).not.toHaveBeenCalledWith("main", "vcs.registerExternalDelta", expect.anything());
    expect(acquireTemplateSnapshot).not.toHaveBeenCalled();
  });

  it("does not acquire or replay unchanged lineage when a new template restores a deleted repository", async () => {
    vi.mocked(acquireTemplateSnapshot).mockClear();
    let imported = false;
    const call = vi.fn(async (_target: string, method: string, input: Record<string, unknown>) => {
      if (method === "vcs.status") return { committed: BASE, workingHead: BASE, clean: true };
      if (method === "vcs.resolveRepository") {
        return imported ? { repositoryId: "repository:gmail", repoPath: "packages/gmail" } : null;
      }
      if (method === "vcs.importSnapshot") {
        imported = true;
        return {
          eventId: "event-import-gmail",
          importedRepositoryIds: ["repository:gmail"],
        };
      }
      throw new Error(`unexpected RPC ${method}: ${JSON.stringify(input)}`);
    });
    const basePin = {
      url: "git+https://example.test/base.git",
      ref: "refs/heads/main",
      commit: "1".repeat(40),
      snapshot: `v1-sha256:${"a".repeat(64)}`,
    };
    const googlePin = {
      url: "git+https://example.test/google-workspace.git",
      ref: "refs/tags/v1",
      commit: "2".repeat(40),
      snapshot: `v1-sha256:${"b".repeat(64)}`,
    };
    const baseDigest = semanticRepositoryDigest([
      { path: "legacy.ts", contentHash: OLD_ONE, mode: 0o644, byteLength: 1 },
    ]);
    const googleDigest = semanticRepositoryDigest([
      { path: "index.ts", contentHash: NEW_ONE, mode: 0o644, byteLength: 1 },
    ]);
    const previous = {
      nodes: [{ nodeId: "t-base", alias: "base", pin: basePin }],
      repositories: {
        "packages/gmail": {
          contributions: [{ nodeId: "t-base", subtreeDigest: baseDigest }],
        },
      },
    };
    const plan = {
      nodes: [
        { nodeId: "t-base", pin: basePin },
        { nodeId: "t-google", pin: googlePin },
      ],
      repositories: {
        "packages/gmail": {
          repoPath: "packages/gmail",
          contributions: [
            {
              nodeId: "t-base",
              alias: "base",
              subdir: "packages/gmail",
              subtreeDigest: baseDigest,
              files: [{ path: "legacy.ts", contentHash: OLD_ONE, size: 1, mode: 0o644 }],
            },
            {
              nodeId: "t-google",
              alias: "google-workspace",
              subdir: "packages/gmail",
              subtreeDigest: googleDigest,
              files: [{ path: "index.ts", contentHash: NEW_ONE, size: 1, mode: 0o644 }],
            },
          ],
        },
      },
    };

    await expect(
      mergeTemplateContributions(
        { rpc: { call } } as never,
        "/state",
        "operation-google",
        plan as never,
        previous as never
      )
    ).resolves.toEqual(["packages/gmail"]);
    expect(call).toHaveBeenCalledWith(
      "main",
      "vcs.importSnapshot",
      expect.objectContaining({
        intentSummary: "Import packages/gmail contribution from google-workspace",
        repositories: [
          {
            repoPath: "packages/gmail",
            files: [expect.objectContaining({ path: "index.ts" })],
          },
        ],
      })
    );
    expect(acquireTemplateSnapshot).not.toHaveBeenCalled();
  });

  it("registers every repository delta before reconciliation mutates the context", async () => {
    vi.mocked(acquireTemplateSnapshot).mockClear();
    const registrations: string[] = [];
    let integrationStarted = false;
    let workingHead: VcsStateNodeRef = BASE;
    let clean = true;
    const call = vi.fn(async (_target: string, method: string, ...args: unknown[]) => {
      const input = args[0] as Record<string, unknown>;
      if (method === "vcs.status") {
        return {
          committed: BASE,
          workingHead,
          clean,
        };
      }
      if (method === "vcs.resolveRepository") {
        return {
          repositoryId: `repository-${input["repoPath"]}`,
          repoPath: input["repoPath"],
        };
      }
      if (method === "vcs.registerExternalDelta") {
        if (integrationStarted) {
          throw new Error("registered a delta after reconciliation changed the working head");
        }
        const repoPath = String(input["repoPath"]);
        registrations.push(repoPath);
        return { deltaId: `delta-${repoPath}-${registrations.length}` };
      }
      if (method === "vcs.compare") {
        return {
          resolution: {
            complete: true,
            remainingCoordinateCount: 0,
            concluded: integrationStarted,
          },
        };
      }
      if (method === "vcs.merge") {
        integrationStarted = true;
        clean = false;
        workingHead = { kind: "application", applicationId: "application-integrated" } as const;
        return { status: "working", workingHead };
      }
      if (method === "vcs.commit") {
        clean = true;
        workingHead = { kind: "event", eventId: "event-integrated" } as const;
        return { event: workingHead };
      }
      if (method === "vcs.finalizeExternalDelta") return {};
      throw new Error(`unexpected RPC ${method}`);
    });
    const oldOneDigest = semanticRepositoryDigest([
      { path: "index.ts", contentHash: OLD_ONE, mode: 0o644, byteLength: 1 },
    ]);
    const oldTwoDigest = semanticRepositoryDigest([
      { path: "index.ts", contentHash: OLD_TWO, mode: 0o644, byteLength: 1 },
    ]);
    const previousPin = {
      url: "git+https://example.test/template.git",
      ref: "refs/tags/v1",
      commit: "1".repeat(40),
      snapshot: `v1-sha256:${"a".repeat(64)}`,
    };
    const nextPin = {
      ...previousPin,
      ref: "refs/tags/v2",
      commit: "2".repeat(40),
      snapshot: `v1-sha256:${"b".repeat(64)}`,
    };
    const files = (contentHash: string) => [
      { path: "index.ts", contentHash, size: 1, mode: 0o644 as const },
    ];
    const plan = {
      nodes: [
        { nodeId: "t-next", pin: nextPin },
        {
          nodeId: "t-news",
          pin: {
            url: "git+https://example.test/news.git",
            ref: "refs/tags/v1",
            commit: "3".repeat(40),
            snapshot: `v1-sha256:${"e".repeat(64)}`,
          },
        },
      ],
      repositories: {
        "panels/one": {
          repoPath: "panels/one",
          contributions: [
            {
              nodeId: "t-next",
              alias: "template",
              subdir: "panels/one",
              subtreeDigest: `v1-sha256:${"c".repeat(64)}`,
              files: files(NEW_ONE),
            },
            {
              nodeId: "t-news",
              alias: "news",
              subdir: "panels/one",
              subtreeDigest: `v1-sha256:${"e".repeat(64)}`,
              files: files("5".repeat(64)),
            },
          ],
        },
        "panels/two": {
          repoPath: "panels/two",
          contributions: [
            {
              nodeId: "t-next",
              alias: "template",
              subdir: "panels/two",
              subtreeDigest: `v1-sha256:${"d".repeat(64)}`,
              files: files(NEW_TWO),
            },
          ],
        },
      },
    };
    const previous = {
      nodes: [{ nodeId: "t-old", pin: previousPin }],
      repositories: {
        "panels/one": {
          contributions: [{ nodeId: "t-old", subtreeDigest: oldOneDigest }],
        },
        "panels/two": {
          contributions: [{ nodeId: "t-old", subtreeDigest: oldTwoDigest }],
        },
      },
    };

    await expect(
      mergeTemplateContributions(
        { rpc: { call } } as never,
        "/state",
        "operation-1",
        plan as never,
        previous as never
      )
    ).resolves.toEqual(["panels/one", "panels/two"]);
    expect(registrations).toEqual(["panels/one", "panels/one", "panels/two"]);
    expect(integrationStarted).toBe(true);
    expect(acquireTemplateSnapshot).toHaveBeenCalledTimes(1);
    expect(call.mock.calls.filter(([, method]) => method === "vcs.status")).toHaveLength(2);
  });
});
