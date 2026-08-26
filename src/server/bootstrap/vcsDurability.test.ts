import type { ManagedService } from "@vibestudio/shared/managedService";
import { describe, expect, it, vi } from "vitest";
import type { DODispatch } from "../doDispatch.js";
import type { WorkspaceVcs } from "../vcsHost/workspaceVcs.js";
import type { WorkspaceSemanticPort } from "../workspaceSourceProvider.js";
import type { WorkerdManager } from "../workerdManager.js";
import { wireVcsDurability, type VcsDurabilityBootstrapDeps } from "./vcsDurability.js";
import { canonicalWorkspaceObjectContextId } from "./workspaceObjectIdentity.js";

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
      { name: "vcsAttach", dependencies: ["doDispatch", "workerdManager"] },
      {
        name: "semanticWorkspace",
        dependencies: ["vcsAttach", "workerdManager"],
      },
      {
        name: "gcEpochCoordinator",
        dependencies: ["semanticWorkspace", "buildSystem"],
      },
    ]);
  });

  it("durably publishes the manifest source-provider entity before attaching it", async () => {
    const dispatch = {
      dispatch: vi.fn(async () => "direct-result"),
    } as unknown as DODispatch;
    const manager = {
      ensureDurableObjectEntity: vi.fn(async () => ({
        targetId: "do:workers/workspace-source:GadWorkspaceDO:workspace",
        effectiveVersion: "a".repeat(64),
        buildKey: "c".repeat(64),
        executionDigest: "b".repeat(64),
        authority: { provides: [], requests: [] },
      })),
    } as unknown as WorkerdManager;
    let gadClient: WorkspaceSemanticPort | undefined;
    const workspaceVcs = {
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
      ({ doDispatch: dispatch, workerdManager: manager })[
        name as "doDispatch" | "workerdManager"
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

    await expect(gadClient?.listContexts({ prefix: "a" })).resolves.toBe("direct-result");
    expect(dispatch.dispatch).toHaveBeenCalledWith(gadRef, "vcsListContexts", { prefix: "a" });
  });

  it("does not release semanticWorkspace until initialization completes", async () => {
    const workspaceVcs = {
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
    } as unknown as WorkerdManager;
    const activateSemanticWorkspace = vi.fn(async () => undefined);
    const publishWorkspaceSourceEntity = vi.fn(async () => undefined);
    const { services } = captureServices({
      workspaceVcs,
      activateSemanticWorkspace,
      publishWorkspaceSourceEntity,
    });
    const semantic = services.find((service) => service.name === "semanticWorkspace");

    const resolve = <D>(name: string) =>
      ({ vcsAttach: workspaceVcs, workerdManager: manager })[
        name as "vcsAttach" | "workerdManager"
      ] as D;
    // The managed dependency guarantees that vcsAttach has established the
    // bootstrap identity before semanticWorkspace starts.
    const attach = services.find((service) => service.name === "vcsAttach");
    const bootstrapResolve = <D>(name: string): D | undefined =>
      ({
        doDispatch: { dispatch: vi.fn() } as unknown as DODispatch,
        workerdManager: manager,
      })[name as "doDispatch" | "workerdManager"] as D | undefined;
    await attach?.start?.(bootstrapResolve);
    await expect(semantic?.start?.(resolve)).resolves.toBe(workspaceVcs);
    expect(activateSemanticWorkspace).toHaveBeenCalledWith(workspaceVcs);
    expect(manager.ensureDurableObjectEntity).toHaveBeenLastCalledWith({
      source: "workers/workspace-source",
      ref: "main",
      className: "GadWorkspaceDO",
      key: "workspace",
      contextId: expect.stringMatching(/^object-/u),
    });
    expect(publishWorkspaceSourceEntity).toHaveBeenCalledTimes(2);
  });
});
