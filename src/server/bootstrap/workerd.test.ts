import type { ManagedService } from "@vibestudio/shared/managedService";
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
      entityCache: inert as WorkerdBootstrapDeps["entityCache"],
      egressProxy: inert as WorkerdBootstrapDeps["egressProxy"],
      gatewayToken: "gateway-token",
      gateway: {
        getPort: () => 7788,
        protocol: "http",
        externalHost: "127.0.0.1",
        configuredAliases: undefined,
      },
      getProductDoEnv: () => ({}),
      runtimeDiagnostics: inert as WorkerdBootstrapDeps["runtimeDiagnostics"],
      eventService: inert as WorkerdBootstrapDeps["eventService"],
      onManagerStarted: vi.fn(),
    });

    expect(services.map(({ name, dependencies }) => ({ name, dependencies }))).toEqual([
      { name: "workerdManager", dependencies: ["buildSystem", "fsService"] },
      { name: "doDispatch", dependencies: ["workerdManager"] },
    ]);
  });
});
