import { sha256HexSyncText } from "@vibestudio/content-addressing";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import type { ManagedService } from "@vibestudio/shared/managedService";
import { describe, expect, it, vi } from "vitest";
import type { DODispatch } from "../doDispatch.js";
import type { WorkspaceVcs } from "../vcsHost/workspaceVcs.js";
import type { WorkspaceSemanticPort } from "../workspaceSourceProvider.js";
import type { RuntimeManager } from "../runtimeManager.js";
import { wireVcsDurability, type VcsDurabilityBootstrapDeps } from "./vcsDurability.js";
import { canonicalWorkspaceObjectContextId } from "./workspaceObjectIdentity.js";
import { WORKSPACE_PARTICIPANT_HISTORY_MIGRATION } from "../vcsHost/workspaceHistoryMigration.js";

function captureServices(overrides: Partial<VcsDurabilityBootstrapDeps> = {}): {
  services: ManagedService[];
  deps: VcsDurabilityBootstrapDeps;
} {
  const services: ManagedService[] = [];
  const inert = {};
  const deps: VcsDurabilityBootstrapDeps = {
    container: { registerManaged: (service) => services.push(service) },
    workspaceVcs: inert as WorkspaceVcs,
    executionPublicationJournal: {
      beginEpoch: vi.fn(() => 1),
      protectedBuildKeys: vi.fn(() => new Set()),
      completeEpoch: vi.fn(),
    } as never,
    workspaceSourceProvider: {
      source: "workers/workspace-source",
      className: "GadWorkspaceDO",
      objectKey: "workspace",
    },
    workspaceId: "workspace-1",
    bootstrapStateHash: `state:${"d".repeat(64)}`,
    publishWorkspaceSourceEntity: vi.fn(async () => undefined),
    readWorkspaceHistoryOwner: vi.fn(async () => null),
    readProtectedMainEventId: vi.fn(() => null),
    activateSemanticWorkspace: vi.fn(async () => undefined),
    ...overrides,
  };
  wireVcsDurability(deps);
  return { services, deps };
}

describe("wireVcsDurability", () => {
  it("registers attachment followed by semantic workspace initialization", () => {
    const { services } = captureServices();

    expect(services.map(({ name, dependencies }) => ({ name, dependencies }))).toEqual([
      { name: "vcsAttach", dependencies: ["doDispatch", "runtimeManager"] },
      {
        name: "semanticWorkspace",
        dependencies: ["vcsAttach"],
      },
      {
        name: "gcEpochCoordinator",
        dependencies: ["semanticWorkspace", "buildSystem"],
      },
    ]);
  });

  it("durably publishes the manifest source-provider entity before attaching it", async () => {
    const dispatch = {
      dispatch: vi.fn(async () => ["direct-result"]),
    } as unknown as DODispatch;
    const manager = {
      ensureDurableObjectEntity: vi.fn(async () => ({
        targetId: "do:workers/workspace-source:GadWorkspaceDO:workspace",
        effectiveVersion: "a".repeat(64),
        buildKey: "c".repeat(64),
        executionDigest: "b".repeat(64),
        authority: { provides: [], requests: [] },
      })),
    } as unknown as RuntimeManager;
    let gadClient: WorkspaceSemanticPort | undefined;
    let semanticReady = Promise.resolve();
    const workspaceVcs = {
      startSemanticInitialization: vi.fn(
        (operation: () => Promise<void>) => (semanticReady = Promise.resolve().then(operation))
      ),
      whenSemanticReady: vi.fn(() => semanticReady),
      attachGad: vi.fn(async (client) => {
        gadClient = client;
      }),
      attachWorkspaceSourceProvider: vi.fn(),
    } as unknown as WorkspaceVcs;
    const publishWorkspaceSourceEntity = vi.fn(async () => undefined);
    const { services } = captureServices({
      workspaceVcs,
      publishWorkspaceSourceEntity,
    });
    const attach = services.find((service) => service.name === "vcsAttach");
    const resolve = <D>(name: string): D | undefined =>
      ({ doDispatch: dispatch, runtimeManager: manager })[
        name as "doDispatch" | "runtimeManager"
      ] as D | undefined;

    await expect(attach?.start?.(resolve)).resolves.toBe(workspaceVcs);

    const gadRef = {
      source: "workers/workspace-source",
      className: "GadWorkspaceDO",
      objectKey: "workspace",
    };
    const contextId = canonicalWorkspaceObjectContextId("workspace-1", {
      source: gadRef.source,
      className: gadRef.className,
      key: gadRef.objectKey,
    });
    expect(manager.ensureDurableObjectEntity).toHaveBeenCalledWith({
      source: gadRef.source,
      ref: `state:${"d".repeat(64)}`,
      className: gadRef.className,
      key: gadRef.objectKey,
      contextId,
    });
    expect(publishWorkspaceSourceEntity).toHaveBeenCalledWith({
      ...gadRef,
      targetId: "do:workers/workspace-source:GadWorkspaceDO:workspace",
      effectiveVersion: "a".repeat(64),
      buildKey: "c".repeat(64),
      executionDigest: "b".repeat(64),
      authority: { provides: [], requests: [] },
      contextId,
    });
    expect(workspaceVcs.attachGad).toHaveBeenCalledOnce();
    expect(workspaceVcs.attachWorkspaceSourceProvider).toHaveBeenCalledOnce();

    await expect(gadClient?.listContexts({ prefix: "a" })).resolves.toEqual(["direct-result"]);
    expect(dispatch.dispatch).toHaveBeenCalledWith(gadRef, "vcsListContexts", { prefix: "a" });
  });

  it("releases attachment while semanticWorkspace awaits the owned initialization", async () => {
    let semanticReady = Promise.resolve();
    const workspaceVcs = {
      startSemanticInitialization: vi.fn(
        (operation: () => Promise<void>) => (semanticReady = Promise.resolve().then(operation))
      ),
      whenSemanticReady: vi.fn(() => semanticReady),
      attachGad: vi.fn(async () => undefined),
      attachWorkspaceSourceProvider: vi.fn(),
    } as unknown as WorkspaceVcs;
    const manager = {
      ensureDurableObjectEntity: vi.fn(async () => ({
        targetId: "do:workers/workspace-source:GadWorkspaceDO:workspace",
        effectiveVersion: "a".repeat(64),
        buildKey: "c".repeat(64),
        executionDigest: "e".repeat(64),
        authority: { provides: [], requests: [] },
      })),
    } as unknown as RuntimeManager;
    let finishInitialization!: () => void;
    const initialization = new Promise<void>((resolve) => {
      finishInitialization = resolve;
    });
    const activateSemanticWorkspace = vi.fn(() => initialization);
    const publishWorkspaceSourceEntity = vi.fn(async () => undefined);
    const { services } = captureServices({
      workspaceVcs,
      activateSemanticWorkspace,
      publishWorkspaceSourceEntity,
    });
    const semantic = services.find((service) => service.name === "semanticWorkspace");

    const resolve = <D>(name: string) =>
      ({ vcsAttach: workspaceVcs, runtimeManager: manager })[
        name as "vcsAttach" | "runtimeManager"
      ] as D;
    // The managed dependency guarantees that vcsAttach has established the
    // bootstrap identity before semanticWorkspace starts.
    const attach = services.find((service) => service.name === "vcsAttach");
    const bootstrapResolve = <D>(name: string): D | undefined =>
      ({
        doDispatch: { dispatch: vi.fn() } as unknown as DODispatch,
        runtimeManager: manager,
      })[name as "doDispatch" | "runtimeManager"] as D | undefined;
    await attach?.start?.(bootstrapResolve);
    const attachmentStop = attach?.stop?.(workspaceVcs);
    let attachmentRetired = false;
    void attachmentStop?.then(() => {
      attachmentRetired = true;
    });
    const semanticStart = semantic?.start?.(resolve);
    let semanticComplete = false;
    void semanticStart?.then(() => {
      semanticComplete = true;
    });
    await Promise.resolve();
    expect(semanticComplete).toBe(false);
    expect(attachmentRetired).toBe(false);
    finishInitialization();
    await expect(semanticStart).resolves.toBe(workspaceVcs);
    await attachmentStop;
    expect(attachmentRetired).toBe(true);
    expect(activateSemanticWorkspace).toHaveBeenCalledWith(workspaceVcs);
    expect(manager.ensureDurableObjectEntity).toHaveBeenCalledOnce();
    expect(publishWorkspaceSourceEntity).toHaveBeenCalledOnce();
  });
  it("reattaches already installed participant history before asynchronous activation", async () => {
    const workspaceId = "workspace-1";
    const source = { source: "workers/workspace-source", className: "GadWorkspaceDO", objectKey: "workspace" };
    const canonical = { ...source, className: "GadHistoryDO", objectKey: "canonical" };
    const contextId = canonicalWorkspaceObjectContextId(workspaceId, {
      source: canonical.source, className: canonical.className, key: canonical.objectKey,
    });
    const targetId = `do:${canonical.source}:${canonical.className}:${canonical.objectKey}`;
    const main = { kind: "event", eventId: "installed-event" };
    const plan = { main, contexts: [], steps: [main] };
    const generation = "b882b7f0-0e3a-4ec3-9f6d-30ea541b14e1";
    const freeze = {
      operationId: WORKSPACE_PARTICIPANT_HISTORY_MIGRATION,
      expectedMainEventId: main.eventId,
    };
    const receipt = {
      head: "installed-head", eventId: main.eventId, contexts: [],
      frozenPlanDigest: sha256HexSyncText(canonicalJson({ source, freeze, plan, generation })),
    };
    const dispatch = vi.fn(async (_target: typeof source, method: string, input: unknown) => {
      if (method === "readHistoryReplayReceipt") return receipt;
      if (method === "beginHistoryReplayFreeze") {
        expect(input).toEqual(freeze);
        return { ...plan, generation };
      }
      throw new Error(`Bootstrap unexpectedly tried ${method}`);
    });
    const sequence: string[] = [];
    const workspaceVcs = {
      attachGad: vi.fn(async () => undefined),
      attachWorkspaceSourceProvider: vi.fn(),
      attachParticipantHistory: vi.fn(async () => { sequence.push("participant"); }),
      startSemanticInitialization: vi.fn(() => { sequence.push("initialization"); }),
    } as unknown as WorkspaceVcs;
    const runtimeManager = {
      ensureDurableObjectEntity: vi.fn(async ({ source, className, key }) => ({
        targetId: `do:${source}:${className}:${key}`, effectiveVersion: "a".repeat(64),
        buildKey: "b".repeat(64), executionDigest: "c".repeat(64),
        authority: { provides: [], requests: [] },
      })),
    } as unknown as RuntimeManager;
    const readWorkspaceHistoryOwner = vi.fn(async () => ({ contextId }));
    const readProtectedMainEventId = vi.fn(() => "since-published");
    const { services } = captureServices({
      workspaceVcs, workspaceId, workspaceSourceProvider: source,
      readWorkspaceHistoryOwner, readProtectedMainEventId,
    });
    const resolve = <D>(name: string): D | undefined =>
      ({ doDispatch: { dispatch }, runtimeManager })[name as "doDispatch" | "runtimeManager"] as D | undefined;
    await services.find((service) => service.name === "vcsAttach")?.start?.(resolve);
    expect(readWorkspaceHistoryOwner).toHaveBeenCalledWith(targetId);
    expect(readProtectedMainEventId).not.toHaveBeenCalled();
    expect(workspaceVcs.attachParticipantHistory).toHaveBeenCalledWith({
      dispatch: { dispatch }, canonical, infrastructureContextId: contextId,
    });
    expect(sequence).toEqual(["participant", "initialization"]);
  });

});
