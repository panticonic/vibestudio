import type { ManagedService } from "@vibestudio/shared/managedService";
import { describe, expect, it, vi } from "vitest";
import type { DODispatch } from "../doDispatch.js";
import type { WorkspaceVcs } from "../vcsHost/workspaceVcs.js";
import type { WorkerdManager } from "../workerdManager.js";
import { wireVcsDurability, type VcsDurabilityBootstrapDeps } from "./vcsDurability.js";

function captureServices(overrides: Partial<VcsDurabilityBootstrapDeps> = {}): {
  services: ManagedService[];
  deps: VcsDurabilityBootstrapDeps;
} {
  const services: ManagedService[] = [];
  const inert = {};
  const deps: VcsDurabilityBootstrapDeps = {
    container: { registerManaged: (service) => services.push(service) },
    workspaceVcs: inert as WorkspaceVcs,
    registerControlPlanePrincipal: vi.fn(),
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
        dependencies: ["vcsAttach"],
      },
      { name: "vcsGcScheduler", dependencies: ["semanticWorkspace"] },
    ]);
  });

  it("attaches the sealed authority and registers its control-plane principal", async () => {
    const dispatch = {
      dispatch: vi.fn(async () => "direct-result"),
    } as unknown as DODispatch;
    const manager = {
      ensureDurableObjectEntity: vi.fn(async () => ({
        targetId: "do:vibestudio/internal:GadWorkspaceDO:workspace-semantic-control-plane",
        effectiveVersion: "a".repeat(64),
        buildKey: "c".repeat(64),
        executionDigest: "b".repeat(64),
        authorityRequests: [],
      })),
    } as unknown as WorkerdManager;
    let gadClient:
      | {
          call<T>(method: string, input: unknown): Promise<T>;
        }
      | undefined;
    const workspaceVcs = {
      attachGad: vi.fn(async (client) => {
        gadClient = client;
      }),
    } as unknown as WorkspaceVcs;
    const registerControlPlanePrincipal = vi.fn();
    const { services } = captureServices({
      workspaceVcs,
      registerControlPlanePrincipal,
    });
    const attach = services.find((service) => service.name === "vcsAttach");
    const resolve = <D>(name: string): D | undefined =>
      ({ doDispatch: dispatch, workerdManager: manager })[
        name as "doDispatch" | "workerdManager"
      ] as D | undefined;

    await expect(attach?.start?.(resolve)).resolves.toBe(workspaceVcs);

    const gadRef = {
      source: "vibestudio/internal",
      className: "GadWorkspaceDO",
      objectKey: "workspace-semantic-control-plane",
    };
    expect(manager.ensureDurableObjectEntity).toHaveBeenCalledWith({
      source: gadRef.source,
      className: gadRef.className,
      key: gadRef.objectKey,
      contextId: "control-plane:workspace-semantic-control-plane",
    });
    expect(registerControlPlanePrincipal).toHaveBeenCalledWith({
      ...gadRef,
      targetId: "do:vibestudio/internal:GadWorkspaceDO:workspace-semantic-control-plane",
      effectiveVersion: "a".repeat(64),
      buildKey: "c".repeat(64),
      executionDigest: "b".repeat(64),
      authorityRequests: [],
    });
    expect(workspaceVcs.attachGad).toHaveBeenCalledOnce();

    await expect(gadClient?.call("read", { key: "a" })).resolves.toBe("direct-result");
    expect(dispatch.dispatch).toHaveBeenCalledWith(gadRef, "read", { key: "a" });
  });

  it("does not release semanticWorkspace until initialization completes", async () => {
    const workspaceVcs = {} as WorkspaceVcs;
    const activateSemanticWorkspace = vi.fn(async () => undefined);
    const { services } = captureServices({ workspaceVcs, activateSemanticWorkspace });
    const semantic = services.find((service) => service.name === "semanticWorkspace");

    const resolve = <D>() => workspaceVcs as D;
    await expect(semantic?.start?.(resolve)).resolves.toBe(workspaceVcs);
    expect(activateSemanticWorkspace).toHaveBeenCalledWith(workspaceVcs);
  });
});
