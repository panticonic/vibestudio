import type { ManagedService } from "@vibestudio/shared/managedService";
import type { ProtectedPublicationEvent } from "@vibestudio/shared/protectedPublicationEvents";
import type { BuildSystemV2 } from "../buildV2/index.js";
import { describe, expect, it, vi } from "vitest";
import {
  parseGatewayAliases,
  resolveWorkerdServerAliasUrls,
  wireWorkerdCore,
  type WorkerdBootstrapDeps,
} from "./workerd.js";

describe("workerd bootstrap policy", () => {
  it("parses JSON and comma-separated gateway aliases", () => {
    expect(parseGatewayAliases('["https://one.example", "https://two.example", 3]')).toEqual([
      "https://one.example",
      "https://two.example",
    ]);
    expect(parseGatewayAliases("https://one.example, https://two.example,,")).toEqual([
      "https://one.example",
      "https://two.example",
    ]);
  });

  it("combines configured aliases with the advertised gateway and removes duplicates", () => {
    expect(
      resolveWorkerdServerAliasUrls({
        getPort: () => 7788,
        protocol: "https",
        externalHost: "studio.example",
        configuredAliases: '["https://alias.example:7788", "https://studio.example:7788"]',
      })
    ).toEqual(["https://alias.example:7788", "https://studio.example:7788"]);
  });

  it("publishes no aliases before the gateway port is finalized", () => {
    expect(
      resolveWorkerdServerAliasUrls({
        getPort: () => null,
        protocol: "http",
        externalHost: "127.0.0.1",
        configuredAliases: "http://alias.example:7788",
      })
    ).toEqual([]);
  });

  it("registers the workerd-to-dispatch lifecycle chain explicitly", () => {
    const services: ManagedService[] = [];
    const inert = {};
    wireWorkerdCore({
      container: { registerManaged: (service) => services.push(service) },
      tokenManager: inert as WorkerdBootstrapDeps["tokenManager"],
      workspacePath: "/workspace",
      statePath: "/workspace/state",
      workspaceId: "workspace-1",
      workspaceDeclarations: inert as WorkerdBootstrapDeps["workspaceDeclarations"],
      userlandResourceHandles: inert as WorkerdBootstrapDeps["userlandResourceHandles"],
      assertBootstrapSnapshotUnchanged: vi.fn(async () => undefined),
      routeRegistry: inert as WorkerdBootstrapDeps["routeRegistry"],
      egressProxy: inert as WorkerdBootstrapDeps["egressProxy"],
      gatewayToken: "gateway-token",
      gateway: {
        getPort: () => 7788,
        protocol: "http",
        externalHost: "127.0.0.1",
        configuredAliases: undefined,
      },
      getInternalDoEnv: () => ({}),
      runtimeDiagnostics: inert as WorkerdBootstrapDeps["runtimeDiagnostics"],
      eventService: inert as WorkerdBootstrapDeps["eventService"],
      resolveEgressCaller: (caller) => caller,
      ensureUserlandDoReady: vi.fn(async () => undefined),
      onManagerStarted: vi.fn(),
      publishSourceBuild: vi.fn(async () => undefined),
    });

    expect(services.map(({ name, dependencies }) => ({ name, dependencies }))).toEqual([
      {
        name: "workerdManager",
        dependencies: ["fsService", "rpcServer"],
      },
      {
        name: "workerdBootstrapWorkspace",
        dependencies: ["workerdManager", "bootstrapBuildSystem"],
      },
      {
        name: "doDispatch",
        dependencies: ["workerdManager", "rpcServer", "workerdBootstrapWorkspace"],
      },
      { name: "workerdWorkspace", dependencies: ["workerdManager", "buildSystem"] },
    ]);
  });

  it("attaches the exact workspace provider after general workerd startup", async () => {
    const services: ManagedService[] = [];
    const assertBootstrapSnapshotUnchanged = vi.fn(async () => undefined);
    const manager = { bindWorkspaceProvider: vi.fn() };
    const workerNode = {
      kind: "worker",
      relativePath: "workers/source",
      manifest: { durable: { classes: [{ className: "SourceDO" }] } },
    };
    const bootstrapBuildSystem = {
      bindRuntimeImage: vi.fn(),
      getBuildByKey: vi.fn(),
      getBuildByExecution: vi.fn(),
      getGraph: () => ({ allNodes: () => [workerNode] }),
    };
    const inert = {};
    wireWorkerdCore({
      container: { registerManaged: (service) => services.push(service) },
      tokenManager: inert as WorkerdBootstrapDeps["tokenManager"],
      workspacePath: "/workspace",
      statePath: "/workspace/state",
      workspaceId: "workspace-1",
      workspaceDeclarations: {
        routes: [{ source: "workers/source", pattern: "/source/*" }],
        singletons: inert,
      } as unknown as WorkerdBootstrapDeps["workspaceDeclarations"],
      userlandResourceHandles: inert as WorkerdBootstrapDeps["userlandResourceHandles"],
      assertBootstrapSnapshotUnchanged,
      routeRegistry: inert as WorkerdBootstrapDeps["routeRegistry"],
      egressProxy: inert as WorkerdBootstrapDeps["egressProxy"],
      gatewayToken: "gateway-token",
      gateway: {
        getPort: () => 7788,
        protocol: "http",
        externalHost: "127.0.0.1",
        configuredAliases: undefined,
      },
      getInternalDoEnv: () => ({ INTERNAL: "1" }),
      runtimeDiagnostics: inert as WorkerdBootstrapDeps["runtimeDiagnostics"],
      eventService: inert as WorkerdBootstrapDeps["eventService"],
      resolveEgressCaller: (caller) => caller,
      ensureUserlandDoReady: vi.fn(async () => undefined),
      onManagerStarted: vi.fn(),
      publishSourceBuild: vi.fn(async () => undefined),
    });

    const attachment = services.find(({ name }) => name === "workerdBootstrapWorkspace");
    await expect(
      attachment?.start?.(<D>(name: string): D | undefined => {
        if (name === "workerdManager") return manager as D;
        if (name === "bootstrapBuildSystem") return bootstrapBuildSystem as D;
        return undefined;
      })
    ).resolves.toBe(manager);

    expect(manager.bindWorkspaceProvider).toHaveBeenCalledOnce();
    expect(assertBootstrapSnapshotUnchanged).toHaveBeenCalledOnce();
    const provider = manager.bindWorkspaceProvider.mock.calls[0]?.[0];
    expect(provider.getManifestRoutes("workers/source")).toEqual([
      { source: "workers/source", pattern: "/source/*" },
    ]);
    expect(provider.getManifestDoClasses("workers/source")).toEqual([{ className: "SourceDO" }]);
  });

  it("reconciles worker classes from one protected publication without scalar-head branching", async () => {
    const services: ManagedService[] = [];
    const reconcileMutableSourceBuild = vi.fn(async () => undefined);
    const manager = {
      bindWorkspaceProvider: vi.fn(),
      replaceWorkspaceProvider: vi.fn(),
      registerAllDOClasses: vi.fn(async () => undefined),
      reconcileManifestRoutes: vi.fn(),
      reconcileMutableSourceBuild,
    };
    let onPushBuild:
      | ((source: string, trigger?: ProtectedPublicationEvent, buildKey?: string) => void)
      | undefined;
    const workerNode = {
      name: "@workspace-workers/example",
      kind: "worker",
      relativePath: "workers/example",
      manifest: { durable: { classes: [{ className: "ExampleDO" }] } },
    };
    const buildSystem = {
      bindRuntimeImage: vi.fn(),
      getBuildByKey: vi.fn(),
      getGraph: () => ({ allNodes: () => [workerNode] }),
      onPushBuild: (
        callback: (source: string, trigger?: ProtectedPublicationEvent, buildKey?: string) => void
      ) => {
        onPushBuild = callback;
      },
    } as unknown as BuildSystemV2;
    const routeRegistry = { registerDoRoutes: vi.fn() };
    const userlandResourceHandles = {
      reconcileProviders: vi.fn(),
      reconcileReceiverClasses: vi.fn(),
    };
    const inert = {};
    const publishSourceBuild: WorkerdBootstrapDeps["publishSourceBuild"] = vi.fn(
      async (workerdManager, source, classes, trigger, buildKey) => {
        await workerdManager.reconcileMutableSourceBuild(source, classes, trigger, buildKey);
      }
    );
    wireWorkerdCore({
      container: { registerManaged: (service) => services.push(service) },
      tokenManager: inert as WorkerdBootstrapDeps["tokenManager"],
      workspacePath: "/workspace",
      statePath: "/workspace/state",
      workspaceId: "workspace-1",
      workspaceDeclarations: {
        routes: [],
        singletons: [],
      } as unknown as WorkerdBootstrapDeps["workspaceDeclarations"],
      userlandResourceHandles:
        userlandResourceHandles as unknown as WorkerdBootstrapDeps["userlandResourceHandles"],
      assertBootstrapSnapshotUnchanged: vi.fn(async () => undefined),
      routeRegistry: routeRegistry as unknown as WorkerdBootstrapDeps["routeRegistry"],
      egressProxy: inert as WorkerdBootstrapDeps["egressProxy"],
      gatewayToken: "gateway-token",
      gateway: {
        getPort: () => 7788,
        protocol: "http",
        externalHost: "127.0.0.1",
        configuredAliases: undefined,
      },
      getInternalDoEnv: () => ({}),
      runtimeDiagnostics: inert as WorkerdBootstrapDeps["runtimeDiagnostics"],
      eventService: inert as WorkerdBootstrapDeps["eventService"],
      resolveEgressCaller: (caller) => caller,
      ensureUserlandDoReady: vi.fn(async () => undefined),
      onManagerStarted: vi.fn(),
      publishSourceBuild,
    });
    const workspaceService = services.find(({ name }) => name === "workerdWorkspace");
    expect(workspaceService).toBeDefined();
    await workspaceService?.start?.(<D>(name: string): D | undefined => {
      if (name === "workerdManager") return manager as D;
      if (name === "buildSystem") return buildSystem as D;
      return undefined;
    });
    expect(onPushBuild).toBeTypeOf("function");
    expect(userlandResourceHandles.reconcileProviders).toHaveBeenCalledWith(
      "workspace-1",
      ["workers/example"],
      "workspace providers reconciled"
    );
    expect(userlandResourceHandles.reconcileReceiverClasses).toHaveBeenCalledWith(
      "workspace-1",
      "workers/example",
      ["ExampleDO"],
      "receiver classes reconciled"
    );

    const publication: ProtectedPublicationEvent = {
      publicationId: "publication:test",
      resultHostRefsBasisDigest: "host-refs:test",
      appliedAt: 42,
      workspaceStateHash: "state:published",
      changedPaths: ["workers/example/index.ts"],
      repositories: [],
    };
    onPushBuild?.("workers/example", publication, "build:test");

    await vi.waitFor(() =>
      expect(reconcileMutableSourceBuild).toHaveBeenCalledWith(
        "workers/example",
        [{ className: "ExampleDO" }],
        publication,
        "build:test"
      )
    );
  });
});
