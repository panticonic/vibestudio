import { describe, expect, it } from "vitest";
import {
  SingletonRegistry,
  buildWorkspaceDeclarations,
  type WorkspaceDeclarations,
} from "@vibestudio/workspace/singletonRegistry";
import { GAD_WORKSPACE_SERVICE_PROTOCOL } from "@vibestudio/shared/workspaceServiceRpc";
import { resolveWorkspaceService } from "./workspaceServices.js";
import type { WorkspaceServiceDecl } from "@vibestudio/workspace-contracts/types";
import type { WorkspaceRouteDecl } from "@vibestudio/workspace-contracts/types";
import { RouteRegistry } from "./routeRegistry.js";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";

const TEST_WORKSPACE_SERVICE_PRESENTATION = {
  action: "use the test service",
  presentation: { domain: "automation" as const, verb: "act" as const },
};

describe("joined HTTP service and route ownership", () => {
  const service: WorkspaceServiceDecl = {
    name: "fixture.http",
    source: "workers/fixture-http",
    ...TEST_WORKSPACE_SERVICE_PRESENTATION,
    authority: { principals: ["code"] },
    worker: { routePath: "/api/jobs" },
  };
  const route: WorkspaceRouteDecl = {
    source: service.source,
    path: "/api/jobs",
    worker: true,
  };
  const build = (routes: WorkspaceRouteDecl[], declaredService = service) =>
    buildWorkspaceDeclarations({
      id: "http-service-contract",
      systemEpoch: WORKSPACE_SYSTEM_EPOCH,
      services: [declaredService],
      routes,
    });

  const invalidRoutes: WorkspaceRouteDecl[][] = [
    [],
    [{ ...route, source: "workers/other" }],
    [{ ...route, path: "/other" }],
    [{ ...route, worker: false, durableObject: { className: "OtherDO" } }],
  ];
  it.each(invalidRoutes.map((routes) => ({ routes })))(
    "rejects a service without its same-source worker route: $routes",
    ({ routes }) => {
      expect(() => build(routes)).toThrow(/stateless worker route.*not declared/);
    }
  );

  it("rejects a route owned by both a worker and a Durable Object", () => {
    expect(() => build([{ ...route, durableObject: { className: "OtherDO" } }])).toThrow(
      /exactly one/
    );
  });

  it.each([" api//jobs/// ", "/api/jobs", "api/jobs/"])(
    "advertises the actual dispatched path for declaration %j",
    (path) => {
      const declarations = build(
        [
          { ...route, path, methods: ["GET"] },
          { ...route, path: "/api/jobs", methods: ["POST"], auth: "admin-token" },
        ],
        { ...service, worker: { routePath: "api//jobs//" } }
      );
      const resolved = resolveWorkspaceService(declarations, service.name);
      expect(resolved.kind).toBe("worker");
      if (resolved.kind !== "worker") throw new Error("Expected HTTP service");
      const registry = new RouteRegistry();
      registry.registerWorkerRoutes(service.source, "fixture-http", [...declarations.routes]);
      expect(resolved.routeBasePath).toBe("/_r/w/workers/fixture-http/api/jobs");
      for (const method of ["GET", "POST"] as const) {
        expect(registry.lookup(resolved.routeBasePath, method, false)).toMatchObject({
          kind: "worker-regular",
          source: service.source,
          remainder: "/api/jobs",
          auth: method === "GET" ? "public" : "admin-token",
        });
      }
    }
  );

  it("resolves and dispatches the root route", () => {
    const declarations = build([{ ...route, path: "///" }], {
      ...service,
      worker: { routePath: "/" },
    });
    const resolved = resolveWorkspaceService(declarations, service.name);
    if (resolved.kind !== "worker") throw new Error("Expected HTTP service");
    const registry = new RouteRegistry();
    registry.registerWorkerRoutes(service.source, "fixture-http", [...declarations.routes]);
    expect(registry.lookup(`${resolved.routeBasePath}/`, "GET", false)).toMatchObject({
      kind: "worker-regular",
      source: service.source,
    });
  });
});

function makeDecls(opts: { withSingleton?: boolean; context?: "creator" }): WorkspaceDeclarations {
  const singletons = new SingletonRegistry(
    opts.withSingleton
      ? [{ source: "workers/example-store", className: "ExampleStoreDO", key: "default" }]
      : []
  );
  return {
    singletons,
    services: [
      {
        source: "workers/example-store",
        name: "channel",
        ...TEST_WORKSPACE_SERVICE_PRESENTATION,
        protocols: ["example.store.v1"],
        authority: { principals: ["code", "user", "host"] },
        durableObject: { className: "ExampleStoreDO", context: opts.context },
      },
    ],
    routes: [],
  };
}

describe("workspace service lookup ownership", () => {
  const service = makeDecls({}).services[0]!;
  const build = (services: WorkspaceServiceDecl[]) =>
    buildWorkspaceDeclarations({
      id: "service-ownership-test",
      systemEpoch: WORKSPACE_SYSTEM_EPOCH,
      services,
    });

  it("resolves a declaration whose name also identifies its protocol", () => {
    const declarations = build([{ ...service, name: "example.store.v1" }]);
    expect(resolveWorkspaceService(declarations, "example.store.v1", "tasks")).toMatchObject({
      source: service.source,
      protocol: "example.store.v1",
      objectKey: "tasks",
    });
  });

  it.each([
    ["same service name", { ...service, source: "workers/other", protocols: [] }],
    ["shared protocol", { ...service, name: "other" }],
    ["name claimed as protocol", { ...service, name: "other", protocols: [service.name] }],
  ])("rejects different declarations claiming the %s", (_label, other) => {
    expect(() => build([service, other])).toThrow(/declared by both/);
  });
});

describe("resolveWorkspaceService — factory vs singleton DO services", () => {
  it("returns the singleton key when a singletonObjects row matches and no objectKey is given", () => {
    const decls = makeDecls({ withSingleton: true });
    const resolved = resolveWorkspaceService(decls, "example.store.v1");
    expect(resolved).toMatchObject({
      kind: "durable-object",
      name: "channel",
      protocol: "example.store.v1",
      className: "ExampleStoreDO",
      objectKey: "default",
    });
  });

  it("rejects an objectKey override when a singleton row exists", () => {
    const decls = makeDecls({ withSingleton: true });
    expect(() => resolveWorkspaceService(decls, "example.store.v1", "chat-1")).toThrow(
      /singleton.*not permitted/i
    );
  });

  it("returns the caller-supplied objectKey for a factory service (no singleton row)", () => {
    const decls = makeDecls({ withSingleton: false });
    const resolved = resolveWorkspaceService(decls, "example.store.v1", "chat-1");
    expect(resolved).toMatchObject({
      kind: "durable-object",
      objectKey: "chat-1",
      targetId: "do:workers/example-store:ExampleStoreDO:chat-1",
    });
  });

  it("preserves creator-context placement on a factory resolution", () => {
    const decls = makeDecls({ context: "creator" });
    expect(resolveWorkspaceService(decls, "example.store.v1", "chat-1")).toMatchObject({
      kind: "durable-object",
      context: "creator",
      objectKey: "chat-1",
    });
  });

  it("rejects creator-context placement on singleton services", () => {
    const decls = makeDecls({ withSingleton: true, context: "creator" });
    expect(() => resolveWorkspaceService(decls, "example.store.v1")).toThrow(
      /creator-context services must be factories/i
    );
  });

  it("throws when resolving a factory service without an objectKey", () => {
    const decls = makeDecls({ withSingleton: false });
    expect(() => resolveWorkspaceService(decls, "example.store.v1")).toThrow(/factory.*objectKey/i);
  });

  it("throws when resolving a factory service with null/undefined objectKey", () => {
    const decls = makeDecls({ withSingleton: false });
    expect(() => resolveWorkspaceService(decls, "example.store.v1", null)).toThrow(
      /factory.*objectKey/i
    );
  });
});

describe("manifest-declared workspace source service", () => {
  const declarations: WorkspaceDeclarations = {
    singletons: new SingletonRegistry([
      {
        source: "workers/workspace-source",
        className: "GadWorkspaceDO",
        key: "workspace",
      },
    ]),
    services: [
      {
        source: "workers/workspace-source",
        name: "gad.workspace",
        title: "Workspace history",
        description: "Read or update your workspace's collaboration and version history.",
        action: "read or update your workspace's collaboration history",
        presentation: { domain: "files", verb: "manage" },
        protocols: [
          GAD_WORKSPACE_SERVICE_PROTOCOL,
          "vibestudio.vcs.v1",
          "vibestudio.workspace-source.v1",
        ],
        authority: {
          principals: ["host", "user", "code", "session", "mission"],
          binding: "declared",
        },
        durableObject: { className: "GadWorkspaceDO" },
      },
    ],
    routes: [],
  };

  it("resolves VCS through the same manifest-declared provider", () => {
    expect(resolveWorkspaceService(declarations, "vibestudio.vcs.v1")).toMatchObject({
      name: "gad.workspace",
      protocol: "vibestudio.vcs.v1",
      objectKey: "workspace",
    });
  });

  it("resolves GAD from the workspace manifest", () => {
    const expected = {
      kind: "durable-object",
      origin: "workspace",
      name: "gad.workspace",
      title: "Workspace history",
      description: "Read or update your workspace's collaboration and version history.",
      action: "read or update your workspace's collaboration history",
      presentation: { domain: "files", verb: "manage" },
      protocols: [
        GAD_WORKSPACE_SERVICE_PROTOCOL,
        "vibestudio.vcs.v1",
        "vibestudio.workspace-source.v1",
      ],
      source: "workers/workspace-source",
      authority: {
        principals: ["host", "user", "code", "session", "mission"],
        binding: "declared",
      },
      className: "GadWorkspaceDO",
      objectKey: "workspace",
      targetId: "do:workers/workspace-source:GadWorkspaceDO:workspace",
    };

    expect(resolveWorkspaceService(declarations, GAD_WORKSPACE_SERVICE_PROTOCOL)).toEqual({
      ...expected,
      protocol: GAD_WORKSPACE_SERVICE_PROTOCOL,
    });
    expect(resolveWorkspaceService(declarations, "gad.workspace")).toEqual(expected);
  });

  it("does not permit fan-out object keys for the control plane", () => {
    expect(() =>
      resolveWorkspaceService(declarations, "vibestudio.gad.workspace.v1", "other")
    ).toThrow(/singleton.*not permitted/i);
  });
});
