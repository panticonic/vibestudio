import { describe, expect, it } from "vitest";
import {
  SingletonRegistry,
  type WorkspaceDeclarations,
} from "@vibestudio/workspace/singletonRegistry";
import { GAD_WORKSPACE_SERVICE_PROTOCOL } from "@vibestudio/shared/workspaceServiceRpc";
import { resolveWorkspaceService } from "./workspaceServices.js";

const TEST_WORKSPACE_SERVICE_PRESENTATION = {
  action: "use the test service",
  presentation: { domain: "automation" as const, verb: "act" as const },
};

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
        authority: { principals: ["host", "user", "code", "session", "mission"] },
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
      authority: { principals: ["host", "user", "code", "session", "mission"] },
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
