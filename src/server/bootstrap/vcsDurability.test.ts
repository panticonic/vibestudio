import { sha256HexSyncText } from "@vibestudio/content-addressing";
import type { ManagedService } from "@vibestudio/shared/managedService";
import { describe, expect, it, vi } from "vitest";
import type { DODispatch } from "../doDispatch.js";
import type { WorkspaceVcs } from "../vcsHost/workspaceVcs.js";
import type { WorkspaceSemanticPort } from "../workspaceSourceProvider.js";
import type { RuntimeManager } from "../runtimeManager.js";
import { wireVcsDurability, type VcsDurabilityBootstrapDeps } from "./vcsDurability.js";
import { canonicalWorkspaceObjectContextId } from "./workspaceObjectIdentity.js";
import { readSharedHistorySeed } from "./sharedHistorySeed.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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

  it("opens an approved seed before activation without replaying the root template", async () => {
    const sequence: string[] = [];
    let initialize: (() => Promise<void>) | undefined;
    const workspaceVcs = {
      attachGad: vi.fn(async () => undefined),
      initializeSharedHistory: vi.fn(async () => { sequence.push("seed"); }),
      attachParticipantHistory: vi.fn(async () => { sequence.push("participant"); }),
      startSemanticInitialization: (operation: () => Promise<void>) => { initialize = operation; },
    } as unknown as WorkspaceVcs;
    const sharedHistorySeed = {
      seed: { sourceNodeId: "a".repeat(64), head: "1".repeat(40), eventId: "seed-event" },
      offer: { destinationNodeId: "b".repeat(64), branch: "seed/fixture", token: "token" },
      fetchPack: vi.fn(), fetchFile: vi.fn(), confirmSource: vi.fn(), remember: vi.fn(),
    };
    const activateSemanticWorkspace = vi.fn(async () => { sequence.push("active"); });
    const { services } = captureServices({ workspaceVcs, sharedHistorySeed, activateSemanticWorkspace });
    const runtimeManager = {
      declaresRemoteDoltClass: vi.fn(() => true),
      workspaceNodeEndpoint: vi.fn(async () => ({ nodeId: "d".repeat(64) })),
      destroyRetiredDOStorage: vi.fn(async () => undefined),
      ensureDurableObjectEntity: vi.fn(async ({ source, className, key }) => ({
        targetId: `do:${source}:${className}:${key}`, effectiveVersion: "a".repeat(64),
        buildKey: "b".repeat(64), executionDigest: "c".repeat(64),
        authority: { provides: [], requests: [] },
      })),
    } as unknown as RuntimeManager;
    const dispatch = vi.fn();
    const resolve = <D>(name: string): D | undefined =>
      ({ doDispatch: { dispatch }, runtimeManager })[name as "doDispatch" | "runtimeManager"] as D | undefined;
    await services.find((service) => service.name === "vcsAttach")?.start?.(resolve);
    await initialize!();
    expect(sequence).toEqual(["seed", "participant", "active"]);
    expect(activateSemanticWorkspace).toHaveBeenCalledWith(workspaceVcs);
    expect(dispatch).not.toHaveBeenCalled();
    const [history] = vi.mocked(workspaceVcs.attachParticipantHistory).mock.calls[0]!;
    const retired = { ...history.canonical, objectKey: `work-${"a".repeat(64)}` };
    await history.destroyRetiredStorage!(retired);
    expect(runtimeManager.destroyRetiredDOStorage).toHaveBeenCalledExactlyOnceWith(retired);
  });

  it.each(["fresh", "reopen"] as const)("activates a %s native root before the legacy source", async (mode) => {
    const sequence: string[] = [];
    let initialize: (() => Promise<void>) | undefined;
    const workspaceVcs = {
      attachGad: vi.fn(async () => undefined),
      initializeFreshHistory: vi.fn(async () => {
        sequence.push("native");
        return true;
      }),
      attachParticipantHistory: vi.fn(async () => { sequence.push("participant"); }),
      startSemanticInitialization: (operation: () => Promise<void>) => { initialize = operation; },
    } as unknown as WorkspaceVcs;
    const canonicalContextId = canonicalWorkspaceObjectContextId("workspace-1", {
      source: "workers/workspace-source", className: "GadHistoryDO", key: "canonical",
    });
    const activateSemanticWorkspace = vi.fn(async () => { sequence.push("active"); });
    const { services } = captureServices({
      workspaceVcs, activateSemanticWorkspace,
      readWorkspaceHistoryOwner: async () => mode === "reopen" ? { contextId: canonicalContextId } : null,
      readProtectedMainEventId: () => mode === "reopen" ? "published" : null,
    });
    const runtimeManager = {
      declaresRemoteDoltClass: vi.fn(() => true),
      ensureDurableObjectEntity: vi.fn(async ({ source, className, key }) => ({
        targetId: `do:${source}:${className}:${key}`,
        effectiveVersion: "a".repeat(64), buildKey: "b".repeat(64), executionDigest: "c".repeat(64),
        authority: { provides: [], requests: [] },
      })),
    } as unknown as RuntimeManager;
    const dispatch = vi.fn();
    const resolve = <D>(name: string): D | undefined =>
      ({ doDispatch: { dispatch }, runtimeManager })[name as "doDispatch" | "runtimeManager"] as D | undefined;
    await services.find((service) => service.name === "vcsAttach")?.start?.(resolve);
    await initialize!();
    expect(sequence).toEqual(["native", "participant", "active"]);
    expect(workspaceVcs.attachParticipantHistory).toHaveBeenCalledWith(expect.objectContaining({ nativeOnly: true }));
    expect(activateSemanticWorkspace).toHaveBeenCalledExactlyOnceWith(workspaceVcs);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("loads approved seed files only for the designated workspace and verified pack", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "shared-history-seed-"));
    try {
      await expect(readSharedHistorySeed(root, "workspace-1")).resolves.toBeNull();
      const seedRoot = path.join(root, "installer-staging");
      await mkdir(seedRoot);
      const manifest = {
        version: 1,
        workspaceId: "workspace-1",
        seed: { sourceNodeId: "a".repeat(64), head: "1".repeat(40), eventId: "seed-event" },
        offer: { destinationNodeId: "b".repeat(64), branch: `seed/${"c".repeat(64)}` },
        packDigest: sha256HexSyncText("seed contents"),
      };
      const approval = path.join(seedRoot, "approved.json");
      const pack = path.join(seedRoot, "history.pack");
      await writeFile(approval, JSON.stringify(manifest));
      await writeFile(pack, "seed contents");
      await expect(readSharedHistorySeed(root, "workspace-2", seedRoot)).rejects.toThrow("different workspace");
      const seed = await readSharedHistorySeed(root, manifest.workspaceId, seedRoot);
      await expect(seed?.fetchPack()).resolves.toEqual(Buffer.from("seed contents"));
      await writeFile(pack, "different contents");
      await expect(seed?.fetchPack()).rejects.toThrow("approved digest");
      await writeFile(approval, `${JSON.stringify(manifest)}\n`);
      await expect(seed?.confirmSource()).rejects.toThrow("approval changed");
      await writeFile(approval, JSON.stringify(manifest));
      await seed?.remember();
      await rm(seedRoot, { recursive: true });
      await expect(readSharedHistorySeed(root, manifest.workspaceId, seedRoot)).resolves.toMatchObject({ seed: manifest.seed });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("durably publishes the manifest source-provider entity before attaching it", async () => {
    const dispatch = {
      dispatch: vi.fn(async () => ["direct-result"]),
    } as unknown as DODispatch;
    const manager = {
      declaresRemoteDoltClass: vi.fn(() => false),
      ensureDurableObjectEntity: vi.fn(async () => ({
        targetId: "do:workers/workspace-source:GadWorkspaceDO:workspace",
        effectiveVersion: "a".repeat(64),
        buildKey: "c".repeat(64),
        executionDigest: "b".repeat(64),
        authority: { provides: [], requests: [] },
      })),
    } as unknown as RuntimeManager;
    let gadClient: WorkspaceSemanticPort | undefined;
    const workspaceVcs = {
      startSemanticInitialization: vi.fn(),
      attachGad: vi.fn(async (client) => {
        gadClient = client;
      }),
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
      initializeFreshHistory: vi.fn(async () => true),
      attachParticipantHistory: vi.fn(async () => undefined),
    } as unknown as WorkspaceVcs;
    const manager = {
      declaresRemoteDoltClass: vi.fn(() => true),
      ensureDurableObjectEntity: vi.fn(async ({ source, className, key }) => ({
        targetId: `do:${source}:${className}:${key}`,
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
    expect(manager.ensureDurableObjectEntity).toHaveBeenCalledTimes(2);
    expect(publishWorkspaceSourceEntity).toHaveBeenCalledTimes(2);
  });
  it("refuses an older workspace before reserving native history", async () => {
    let initialize: (() => Promise<void>) | undefined;
    const workspaceVcs = {
      attachGad: vi.fn(async () => undefined),
      initializeFreshHistory: vi.fn(),
      startSemanticInitialization: (operation: () => Promise<void>) => { initialize = operation; },
    } as unknown as WorkspaceVcs;
    const { services } = captureServices({
      workspaceVcs,
      readProtectedMainEventId: () => "previously-saved-work",
    });
    const runtimeManager = {
      declaresRemoteDoltClass: vi.fn(() => true),
      ensureDurableObjectEntity: vi.fn(async () => ({
        targetId: "do:workers/workspace-source:GadWorkspaceDO:workspace",
      })),
    } as unknown as RuntimeManager;
    const dispatch = vi.fn();
    const resolve = <D>(name: string): D | undefined =>
      ({ doDispatch: { dispatch }, runtimeManager })[name as "doDispatch" | "runtimeManager"] as D | undefined;
    await services.find((service) => service.name === "vcsAttach")?.start?.(resolve);
    await expect(initialize!()).rejects.toThrow("saved history in an older format");
    expect(runtimeManager.ensureDurableObjectEntity).toHaveBeenCalledOnce();
    expect(workspaceVcs.initializeFreshHistory).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
