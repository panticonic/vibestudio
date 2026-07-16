/**
 * Panel navigation regression tests.
 *
 * Plan §Test coverage: "Panel navigation: navigation retires subtree + creates
 * fresh entity; back-navigation rematerializes the same history-entry id;
 * capability grants on the same source survive (version-scoped); per-caller
 * egress credentials reissue."
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createTestDO } from "@vibestudio/durable/test-utils";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { requestCapabilityPermission } from "./capabilityPermission.js";
import { createRuntimeService } from "./runtimeService.js";
import type { ApprovalQueue } from "./approvalQueue.js";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { WorkspaceEntityStore } from "../workspaceEntityStore.js";
import { canonicalEntityId, type EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { DODispatch } from "../doDispatch.js";
import type { DORef } from "@vibestudio/shared/doDispatcher";
import { WorkspaceDO } from "../internalDOs/workspaceDO.js";
import { WorkspaceDOTestable } from "../internalDOs/workspaceDO.testFixture.js";
import { sha256 } from "@vibestudio/shared/execution/identity";

function tempStatePath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-panel-nav-"));
}

function approvalQueueMock(
  decision: Awaited<ReturnType<ApprovalQueue["request"]>> = "version"
): ApprovalQueue {
  return {
    request: vi.fn(async () => decision),
    requestCapability: vi.fn(async () => decision),
    requestClientConfig: vi.fn(async () => ({ decision: "deny" as const })),
    requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
    requestCredentialInput: vi.fn(async () => ({ decision: "deny" as const })),
    requestUserland: vi.fn(async () => ({ kind: "dismissed" as const })),
    presentDeviceCode: vi.fn(() => ({
      approvalId: "device-code-test",
      cancelled: new AbortController().signal,
      dispose: vi.fn(),
    })),
    resolve: vi.fn(),
    resolveUserland: vi.fn(),
    requestExternalAgent: vi.fn(async () => ({ behavior: "deny" as const })),
    resolveExternalAgent: vi.fn(),
    settleExternalAgent: vi.fn(() => 0),
    resolveExternalAgentByRequest: vi.fn(async () => 0),
    submitClientConfig: vi.fn(),
    submitSecretInput: vi.fn(),
    submitCredentialInput: vi.fn(),
    listPending: vi.fn(() => []),
    cancelForCaller: vi.fn(),
  };
}

function makeDODispatch(instance: WorkspaceDO): {
  dispatch: DODispatch;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(async (_ref: DORef, method: string, ...args: unknown[]) => {
    const fn = (instance as unknown as Record<string, unknown>)[method];
    if (typeof fn !== "function") throw new Error(`WorkspaceDO has no method ${method}`);
    return (fn as (...a: unknown[]) => unknown).apply(instance, args);
  });
  return { spy, dispatch: { dispatch: spy } as unknown as DODispatch };
}

describe("panel navigation: capability grants and retire hooks", () => {
  it("a version-scoped grant on (repoPath, executionDigest) survives panel retire+recreate for the same source", async () => {
    const approvalQueue = approvalQueueMock("version");
    const grantStore = new CapabilityGrantStore({ statePath: tempStatePath() });
    const deps = { approvalQueue, grantStore };

    // First request from "panel-1" gets approved with "version" scope.
    const request1 = {
      caller: createVerifiedCaller("panel:nav-1", "panel", {
        callerId: "panel:nav-1",
        callerKind: "panel" as const,
        repoPath: "workers/foo",
        executionDigest: "a".repeat(64),
        delegations: [],
        requested: [
          { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
          { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
        ],
      }),
      capability: "egress.fetch",
      resource: { type: "host", label: "Host", value: "example.com", key: "example.com" },
      title: "Fetch example.com",
      deniedReason: "denied",
    };
    const res1 = await requestCapabilityPermission(deps, request1);
    expect(res1.allowed).toBe(true);
    expect(approvalQueue.requestCapability).toHaveBeenCalledTimes(1);

    // Now simulate panel navigation: the panel entity is retired and a brand-new
    // entity (different id, same source+version) is created on back-or-forward navigation.
    const request2 = {
      ...request1,
      caller: createVerifiedCaller("panel:nav-2", "panel", {
        callerId: "panel:nav-2",
        callerKind: "panel" as const,
        repoPath: "workers/foo",
        executionDigest: "a".repeat(64),
        delegations: [],
        requested: [
          { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
          { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
        ],
      }),
    };
    const res2 = await requestCapabilityPermission(deps, request2);
    expect(res2.allowed).toBe(true);
    // No re-prompt — grant is version-scoped, not principal-scoped.
    expect(approvalQueue.requestCapability).toHaveBeenCalledTimes(1);
  });

  it("a version-scoped grant does NOT cross to a different executionDigest (re-prompt required)", async () => {
    const approvalQueue = approvalQueueMock("version");
    const grantStore = new CapabilityGrantStore({ statePath: tempStatePath() });
    const deps = { approvalQueue, grantStore };

    const baseRequest = {
      capability: "egress.fetch",
      resource: { type: "host", label: "Host", value: "example.com", key: "example.com" },
      title: "Fetch example.com",
      deniedReason: "denied",
    };

    await requestCapabilityPermission(deps, {
      ...baseRequest,
      caller: createVerifiedCaller("panel:v1", "panel", {
        callerId: "panel:v1",
        callerKind: "panel",
        repoPath: "workers/foo",
        executionDigest: "a".repeat(64),
        delegations: [],
        requested: [
          { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
          { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
        ],
      }),
    });

    await requestCapabilityPermission(deps, {
      ...baseRequest,
      caller: createVerifiedCaller("panel:v2", "panel", {
        callerId: "panel:v2",
        callerKind: "panel",
        repoPath: "workers/foo",
        executionDigest: "b".repeat(64),
        delegations: [],
        requested: [
          { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
          { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
        ], // <-- different version
      }),
    });

    // Two prompts because version differs.
    expect(approvalQueue.requestCapability).toHaveBeenCalledTimes(2);
  });

  it("retiring a panel fires onRetire with the panel entity record (so cleanup hooks like egressProxy.dropCaller run)", async () => {
    const { instance } = await createTestDO(WorkspaceDOTestable);
    const { dispatch } = makeDODispatch(instance);
    const entityCache = new EntityCache();
    const retiredRecords: EntityRecord[] = [];

    const service = createRuntimeService({
      entityStore: new WorkspaceEntityStore({
        doDispatch: dispatch,
        workspaceId: "workspace-nav",
        entityCache,
      }),
      resolveExecutionArtifact: async (source) => ({
        unitName: source,
        selectorPolicy: { kind: "head", repoPath: source, head: "main" },
        artifact: {
          source: {
            repoPath: source,
            sourceEv: sha256("source"),
            stateHash: sha256("state"),
          },
          recipeDigest: sha256("recipe"),
          buildKey: sha256("build"),
          artifactDigest: sha256("artifact"),
          executionDigest: sha256("execution"),
        },
        requested: [],
        delegations: [],
        compilationCacheKey: `test:${source}`,
      }),
      resolveExecutionArtifactByDigest: (executionDigest) => {
        throw new Error(`Unexpected exact execution lookup: ${executionDigest}`);
      },
      hooks: {
        prepareDurableObject: vi.fn(async () => ({ targetId: "t", executionDigest: "v" })),
        prepareWorker: vi.fn(async () => ({ targetId: "t", executionDigest: "v" })),
        preparePanel: vi.fn(async () => {}),
        prepareApp: vi.fn(async () => {}),
        onRetire: async (record) => {
          retiredRecords.push(record);
        },
      },
      contextBoundary: { contextExists: () => false },
      contextFolders: {
        ensureContextFolder: vi.fn(async (contextId: string) => `/tmp/contexts/${contextId}`),
        removeContext: vi.fn(async () => {}),
      },
    });

    const handle = (await service.handler(
      { caller: createVerifiedCaller("server", "server") },
      "createEntity",
      [
        {
          kind: "panel",
          surface: "workspace",
          source: "panels/chat",
          contextId: "ctx-x",
          key: "nav-entry-1",
        },
      ]
    )) as { id: string };

    expect(handle.id).toBe(canonicalEntityId({ kind: "panel", key: "nav-entry-1" }));

    await service.handler({ caller: createVerifiedCaller("server", "server") }, "retireEntity", [
      { id: handle.id },
    ]);

    // Hook was called with the retired panel record. Real bootstrap wires this
    // to egressProxy.dropCaller(record.id) etc. — proving the call site is
    // reached is sufficient at this layer.
    expect(retiredRecords).toHaveLength(1);
    expect(retiredRecords[0]?.id).toBe(handle.id);
    expect(retiredRecords[0]?.kind).toBe("panel");
    expect(retiredRecords[0]?.status).toBe("retired");
  });
});
