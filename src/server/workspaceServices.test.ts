import { describe, expect, it } from "vitest";
import {
  SingletonRegistry,
  type WorkspaceDeclarations,
} from "@vibestudio/workspace/singletonRegistry";
import { resolveWorkspaceService } from "./workspaceServices.js";

function makeDecls(opts: { withSingleton?: boolean }): WorkspaceDeclarations {
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
        protocols: ["example.store.v1"],
        policy: { allowed: ["panel", "shell", "server", "worker", "extension"] },
        durableObject: { className: "ExampleStoreDO" },
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
      className: "ExampleStoreDO",
      objectKey: "default",
    });
  });

  it("honours an explicit objectKey override even when a singleton row exists", () => {
    const decls = makeDecls({ withSingleton: true });
    const resolved = resolveWorkspaceService(decls, "example.store.v1", "chat-1");
    expect(resolved).toMatchObject({
      kind: "durable-object",
      objectKey: "chat-1",
      targetId: "do:workers/example-store:ExampleStoreDO:chat-1",
    });
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

describe("sealed semantic control-plane services", () => {
  const empty: WorkspaceDeclarations = {
    singletons: new SingletonRegistry([]),
    services: [],
    routes: [],
  };

  it("does not expose a duplicate VCS service through workspace declarations", () => {
    expect(() => resolveWorkspaceService(empty, "vibestudio.vcs.v1")).toThrow(
      /No workspace service registered/
    );
  });

  it("resolves the GAD graph through the same sealed object", () => {
    expect(resolveWorkspaceService(empty, "vibestudio.gad.workspace.v1")).toMatchObject({
      title: "GAD workspace graph",
      source: "vibestudio/internal",
      className: "GadWorkspaceDO",
      objectKey: "workspace-semantic-control-plane",
    });
  });

  it("does not permit fan-out object keys for the control plane", () => {
    expect(() => resolveWorkspaceService(empty, "vibestudio.gad.workspace.v1", "other")).toThrow(
      /one sealed object key/i
    );
  });
});
