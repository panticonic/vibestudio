import type { ManagedService } from "@vibestudio/shared/managedService";
import {
  SingletonRegistry,
  type WorkspaceDeclarations,
} from "@vibestudio/workspace/singletonRegistry";
import { describe, expect, it, vi } from "vitest";
import type { DODispatch } from "../doDispatch.js";
import type { WorkspaceVcs } from "../vcsHost/workspaceVcs.js";
import type { WorkerdManager } from "../workerdManager.js";
import { wireVcsDurability, type VcsDurabilityBootstrapDeps } from "./vcsDurability.js";

function declarations(withBinding: boolean): WorkspaceDeclarations {
  return {
    singletons: new SingletonRegistry(
      withBinding
        ? [{ source: "workers/gad-store", className: "GadWorkspaceDO", key: "workspace-gad" }]
        : []
    ),
    services: withBinding
      ? [
          {
            source: "workers/gad-store",
            name: "vcs",
            protocols: ["vibestudio.vcs.v1"],
            policy: { allowed: ["server"] },
            durableObject: { className: "GadWorkspaceDO" },
          },
        ]
      : [],
    routes: [],
  };
}

function captureServices(overrides: Partial<VcsDurabilityBootstrapDeps> = {}): {
  services: ManagedService[];
  deps: VcsDurabilityBootstrapDeps;
} {
  const services: ManagedService[] = [];
  const inert = {};
  const deps: VcsDurabilityBootstrapDeps = {
    container: { registerManaged: (service) => services.push(service) },
    workspaceDeclarations: declarations(true),
    workspaceVcs: inert as WorkspaceVcs,
    startupBarrier: Promise.resolve(),
    systemOwnerUserId: "system",
    activateDurableObject: vi.fn(),
    ...overrides,
  };
  wireVcsDurability(deps);
  return { services, deps };
}

describe("wireVcsDurability", () => {
  it("registers attachment before maintenance", () => {
    const { services } = captureServices();

    expect(services.map(({ name, dependencies }) => ({ name, dependencies }))).toEqual([
      { name: "vcsAttach", dependencies: ["doDispatch", "workerdManager"] },
      { name: "vcsGcScheduler", dependencies: ["vcsAttach"] },
    ]);
  });

  it("keeps local VCS available when no durable binding is declared", async () => {
    const workspaceVcs = {} as WorkspaceVcs;
    const activateDurableObject = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { services } = captureServices({
        workspaceDeclarations: declarations(false),
        workspaceVcs,
        activateDurableObject,
      });
      const attach = services.find((service) => service.name === "vcsAttach");

      await expect(attach?.start?.(() => undefined)).resolves.toBe(workspaceVcs);
      expect(activateDurableObject).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringContaining("durable VCS store disabled"));
    } finally {
      error.mockRestore();
    }
  });

  it("activates, attaches, and enables indexing through the declared VCS object", async () => {
    const dispatch = {
      dispatch: vi.fn(async () => "direct-result"),
      dispatchOnBehalf: vi.fn(async () => "delegated-result"),
    } as unknown as DODispatch;
    const manager = {} as WorkerdManager;
    let gadClient:
      | {
          call<T>(method: string, input: unknown, opts?: { invocationToken?: string }): Promise<T>;
        }
      | undefined;
    const workspaceVcs = {
      attachGad: vi.fn(async (client) => {
        gadClient = client;
      }),
      memory: { enable: vi.fn() },
    } as unknown as WorkspaceVcs;
    const startupBarrier = Promise.resolve();
    const activateDurableObject = vi.fn(async () => undefined);
    const { services } = captureServices({
      workspaceVcs,
      startupBarrier,
      activateDurableObject,
    });
    const attach = services.find((service) => service.name === "vcsAttach");
    const resolve = <D>(name: string): D | undefined =>
      ({ doDispatch: dispatch, workerdManager: manager })[
        name as "doDispatch" | "workerdManager"
      ] as D | undefined;

    await expect(attach?.start?.(resolve)).resolves.toBe(workspaceVcs);

    const gadRef = {
      source: "workers/gad-store",
      className: "GadWorkspaceDO",
      objectKey: "workspace-gad",
      buildRef: "main",
    };
    expect(activateDurableObject).toHaveBeenCalledWith(dispatch, manager, {
      ...gadRef,
      ownerUserId: "system",
    });
    expect(workspaceVcs.attachGad).toHaveBeenCalledOnce();
    expect(workspaceVcs.memory.enable).toHaveBeenCalledWith({ startupBarrier });

    await expect(gadClient?.call("read", { key: "a" })).resolves.toBe("direct-result");
    expect(dispatch.dispatch).toHaveBeenCalledWith(gadRef, "read", { key: "a" });
    await expect(
      gadClient?.call("write", { key: "a" }, { invocationToken: "invocation-1" })
    ).resolves.toBe("delegated-result");
    expect(dispatch.dispatchOnBehalf).toHaveBeenCalledWith(
      gadRef,
      "write",
      [{ key: "a" }],
      "invocation-1"
    );
  });
});
