import { describe, expect, it } from "vitest";
import {
  SingletonRegistry,
  type WorkspaceDeclarations,
} from "@vibez1/shared/workspace/singletonRegistry";
import { resolveUserlandService, resolveVcsStoreBinding } from "./userlandServices.js";

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

describe("resolveUserlandService — factory vs singleton DO services", () => {
  it("returns the singleton key when a singletonObjects row matches and no objectKey is given", () => {
    const decls = makeDecls({ withSingleton: true });
    const resolved = resolveUserlandService(decls, "example.store.v1");
    expect(resolved).toMatchObject({
      kind: "durable-object",
      name: "channel",
      className: "ExampleStoreDO",
      objectKey: "default",
    });
  });

  it("honours an explicit objectKey override even when a singleton row exists", () => {
    const decls = makeDecls({ withSingleton: true });
    const resolved = resolveUserlandService(decls, "example.store.v1", "chat-1");
    expect(resolved).toMatchObject({
      kind: "durable-object",
      objectKey: "chat-1",
      targetId: "do:workers/example-store:ExampleStoreDO:chat-1",
    });
  });

  it("returns the caller-supplied objectKey for a factory service (no singleton row)", () => {
    const decls = makeDecls({ withSingleton: false });
    const resolved = resolveUserlandService(decls, "example.store.v1", "chat-1");
    expect(resolved).toMatchObject({
      kind: "durable-object",
      objectKey: "chat-1",
      targetId: "do:workers/example-store:ExampleStoreDO:chat-1",
    });
  });

  it("throws when resolving a factory service without an objectKey", () => {
    const decls = makeDecls({ withSingleton: false });
    expect(() => resolveUserlandService(decls, "example.store.v1")).toThrow(/factory.*objectKey/i);
  });

  it("throws when resolving a factory service with null/undefined objectKey", () => {
    const decls = makeDecls({ withSingleton: false });
    expect(() => resolveUserlandService(decls, "example.store.v1", null)).toThrow(
      /factory.*objectKey/i
    );
  });
});

describe("resolveVcsStoreBinding — the vcs service IS the store declaration", () => {
  const vcsDecls = (withSingleton: boolean): WorkspaceDeclarations => ({
    singletons: new SingletonRegistry(
      withSingleton
        ? [{ source: "workers/gad-store", className: "GadWorkspaceDO", key: "workspace-gad" }]
        : []
    ),
    services: [
      {
        source: "workers/gad-store",
        name: "vcs",
        protocols: ["vibez1.vcs.v1"],
        policy: { allowed: ["panel", "shell", "server", "worker", "extension"] },
        durableObject: { className: "GadWorkspaceDO" },
      },
    ],
    routes: [],
  });

  it("resolves the DO binding from the `vcs` service declaration + its singleton row", () => {
    expect(resolveVcsStoreBinding(vcsDecls(true))).toEqual({
      source: "workers/gad-store",
      className: "GadWorkspaceDO",
      objectKey: "workspace-gad",
    });
  });

  it("returns null when no vcs service is declared (durable store disabled)", () => {
    expect(
      resolveVcsStoreBinding({ singletons: new SingletonRegistry([]), services: [], routes: [] })
    ).toBeNull();
  });

  it("returns null for a factory vcs DO (no singleton row names a concrete object)", () => {
    expect(resolveVcsStoreBinding(vcsDecls(false))).toBeNull();
  });
});
