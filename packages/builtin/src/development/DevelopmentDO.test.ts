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

  it("resolves session repositories through the canonical public VCS service", async () => {
    const { instance } = await development();
    const workingHead = { kind: "event" as const, eventId: "event:main" };
    const rpcCall = vi.fn(async (target: string, method: string) => {
      if (target !== "main") throw new Error(`Unexpected target ${target}`);
      if (method === "vcs.status") return { workingHead };
      if (method === "vcs.inspect") {
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

    const resolved = await (
      instance as unknown as {
        resolveRepository(
          contextId: string,
          repositoryId: string
        ): Promise<{ repoPath: string; sourceState: typeof workingHead } | null>;
      }
    ).resolveRepository("context:self-development", "repository:vibestudio");

    expect(resolved).toEqual({
      repoPath: "projects/vibestudio",
      sourceState: workingHead,
    });
    expect(rpcCall).toHaveBeenNthCalledWith(1, "main", "vcs.status", [
      { contextId: "context:self-development" },
    ]);
    expect(rpcCall).toHaveBeenNthCalledWith(2, "main", "vcs.inspect", [
      {
        node: {
          kind: "repository",
          state: workingHead,
          repositoryId: "repository:vibestudio",
        },
        edgeLimit: 1,
      },
    ]);
  });
});
