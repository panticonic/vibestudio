import { describe, expect, it, vi } from "vitest";
import { createTestDO } from "@vibestudio/durable/test-utils";
import { rpcExposedMethodNames } from "@vibestudio/rpc";
import { developmentBuiltinMethods } from "@vibestudio/service-schemas/development";
import { DevelopmentDO } from "./DevelopmentDO.js";

async function development() {
  return createTestDO(DevelopmentDO, {
    WORKER_SOURCE: "vibestudio/internal",
    WORKER_CLASS_NAME: "DevelopmentDO",
    __objectKey: "workspace",
  });
}

describe("DevelopmentDO", () => {
  it("exposes exactly the typed builtin contract", async () => {
    const { instance } = await development();
    const methods = [...rpcExposedMethodNames(instance)].filter(
      (method) => method !== "durableWorkCapabilities"
    );
    expect(methods.sort()).toEqual(Object.keys(developmentBuiltinMethods).sort());
  });

  it("owns reviewed recipe selection while the host supplies only its platform", async () => {
    const { instance, callAs } = await development();
    const rpcCall = vi.fn(async (_target: string, method: string) => {
      if (method === "developmentNative.describeHost") {
        return { platform: "linux", arch: "x64" };
      }
      throw new Error(`Unexpected ${method}`);
    });
    Object.defineProperty(instance, "rpc", {
      value: { call: rpcCall },
      configurable: true,
    });

    const recipes = await callAs(
      { callerId: "panel:development", callerKind: "panel", userId: "alice" },
      "listRecipes"
    );
    expect(recipes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipeId: "vibestudio-monorepo-build-v1",
          platform: "linux",
          arch: "x64",
        }),
      ])
    );
    expect(rpcCall).toHaveBeenCalledWith("main", "developmentNative.describeHost", []);
  });

  it("supplies host-attested semantic ingress when resolving session repositories", async () => {
    const { instance, callAs } = await development();
    const parentHead = { kind: "event" as const, eventId: "event:parent" };
    const childHead = { kind: "event" as const, eventId: "event:child" };
    const workspaceSource = "do:workers/workspace-source:GadWorkspaceDO:workspace";
    const rpcCall = vi.fn(async (target: string, method: string, args: unknown[]) => {
      if (target === "main" && method === "runtime.resolveContext") return "context:parent";
      if (target === "main" && method === "workers.resolveService") {
        return { kind: "durable-object", targetId: workspaceSource };
      }
      if (target === "main" && method === "runtime.forkSemanticContext") {
        return {
          contextId: "context:child",
          parentContextId: "context:parent",
          parentWorkingHead: parentHead,
          childBaseState: childHead,
        };
      }
      if (target === workspaceSource && method === "vcsStatus") {
        const request = args[0] as { input: { contextId: string } };
        return {
          workingHead: request.input.contextId === "context:parent" ? parentHead : childHead,
        };
      }
      if (target === workspaceSource && method === "vcsInspect") {
        return {
          node: {
            kind: "repository",
            value: { kind: "present", repoPath: "projects/vibestudio" },
          },
        };
      }
      throw new Error(`Unexpected ${method}`);
    });
    Object.defineProperty(instance, "rpc", {
      value: { call: rpcCall },
      configurable: true,
    });

    const opened = await callAs(
      { callerId: "panel:development", callerKind: "panel", userId: "alice" },
      "openSession",
      {
        repositoryId: "repository:vibestudio",
        mode: "semantic",
        idempotencyKey: "open:self-development",
      }
    );

    expect(opened).toMatchObject({
      kind: "opened",
      session: {
        contextId: "context:child",
        repository: {
          repositoryId: "repository:vibestudio",
          repoPath: "projects/vibestudio",
        },
      },
    });
    const semanticCalls = rpcCall.mock.calls.filter(
      ([target, method]) => target === workspaceSource && String(method).startsWith("vcs")
    );
    expect(semanticCalls).toHaveLength(4);
    for (const [, , args] of semanticCalls) {
      expect(args).toEqual([
        expect.objectContaining({
          input: expect.any(Object),
          ingress: {
            causalParent: null,
            contextIntegrity: { class: "internal", externalKeys: [] },
          },
        }),
      ]);
    }
  });
});
