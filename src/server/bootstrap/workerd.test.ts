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
      onManagerStarted: vi.fn(),
    });

    expect(services.map(({ name, dependencies }) => ({ name, dependencies }))).toEqual([
      { name: "workerdManager", dependencies: ["fsService", "rpcServer"] },
      { name: "doDispatch", dependencies: ["workerdManager"] },
      { name: "workerdWorkspace", dependencies: ["workerdManager", "buildSystem"] },
    ]);
  });

  it("reconciles worker classes from one protected publication without scalar-head branching", async () => {
    const services: ManagedService[] = [];
    const onSourceRebuilt = vi.fn(async () => undefined);
    const manager = {
      bindWorkspaceProvider: vi.fn(),
      registerAllDOClasses: vi.fn(async () => undefined),
      reconcileManifestRoutes: vi.fn(),
      onSourceRebuilt,
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
    const inert = {};
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
      onManagerStarted: vi.fn(),
    });
    const workspaceService = services.find(({ name }) => name === "workerdWorkspace");
    expect(workspaceService).toBeDefined();
    await workspaceService?.start?.(<D>(name: string): D | undefined => {
      if (name === "workerdManager") return manager as D;
      if (name === "buildSystem") return buildSystem as D;
      return undefined;
    });
    expect(onPushBuild).toBeTypeOf("function");

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
      expect(onSourceRebuilt).toHaveBeenCalledWith(
        "workers/example",
        [{ className: "ExampleDO" }],
        publication,
        "build:test"
      )
    );
  });
});
