import { describe, expect, it, vi } from "vitest";
import { createBuildServiceClient, createEvalImportLoader } from "./evalImportLoader.js";

describe("createEvalImportLoader", () => {
  it("loads npm refs through getBuildNpm", async () => {
    const call = vi.fn(async () => ({ bundle: "npm-bundle" }));
    const loadImport = createEvalImportLoader(createBuildServiceClient(call), "worker");

    await expect(loadImport("left-pad", "npm:1.3.0", ["react"])).resolves.toBe("npm-bundle");

    expect(call).toHaveBeenCalledWith("build", "getBuildNpm", ["left-pad", "1.3.0", ["react"]]);
  });

  it("accepts package-qualified npm refs when the package matches the import key", async () => {
    const call = vi.fn(async () => ({ bundle: "npm-bundle" }));
    const loadImport = createEvalImportLoader(createBuildServiceClient(call), "worker");

    await expect(loadImport("left-pad", "npm:left-pad@1.3.0", [])).resolves.toBe("npm-bundle");
    await expect(loadImport("@scope/pkg", "npm:@scope/pkg@2.0.0", [])).resolves.toBe("npm-bundle");

    expect(call).toHaveBeenNthCalledWith(1, "build", "getBuildNpm", ["left-pad", "1.3.0", []]);
    expect(call).toHaveBeenNthCalledWith(2, "build", "getBuildNpm", ["@scope/pkg", "2.0.0", []]);
  });

  it("rejects package-qualified npm refs when the package does not match the import key", async () => {
    const call = vi.fn(async () => ({ bundle: "npm-bundle" }));
    const loadImport = createEvalImportLoader(createBuildServiceClient(call), "worker");

    await expect(loadImport("left-pad", "npm:lodash@4.17.21", [])).rejects.toThrow(
      'npm import "left-pad" points at "lodash"'
    );
    expect(call).not.toHaveBeenCalled();
  });

  it("loads workspace refs as library builds tagged with the host target", async () => {
    const call = vi.fn(async () => ({ bundle: "workspace-bundle" }));
    const loadImport = createEvalImportLoader(createBuildServiceClient(call), "eval");

    await expect(loadImport("@workspace/pkg", "abc123", ["react"])).resolves.toBe(
      "workspace-bundle"
    );

    expect(call).toHaveBeenCalledWith("build", "getBuild", [
      "@workspace/pkg",
      "abc123",
      { library: true, externals: ["react"], libraryTarget: "eval" },
    ]);
  });

  it("resolves automatic and workspace-protocol refs against the sandbox context", async () => {
    const call = vi.fn(async (_service: string, _method: string, _args: unknown[]) => ({
      bundle: "workspace-bundle",
    }));
    const loadImport = createEvalImportLoader(createBuildServiceClient(call), "worker", {
      defaultWorkspaceRef: () => "ctx:eval-context",
    });

    for (const ref of [undefined, "latest", "workspace", "workspace:*", "workspace:^"]) {
      await expect(loadImport("@workspace/pkg", ref, [])).resolves.toBe("workspace-bundle");
    }

    for (let index = 1; index <= 5; index += 1) {
      expect(call).toHaveBeenNthCalledWith(index, "build", "getBuild", [
        "@workspace/pkg",
        "ctx:eval-context",
        { library: true, externals: [], libraryTarget: "worker" },
      ]);
    }
  });

  it("preserves explicit GAD workspace refs", async () => {
    const call = vi.fn(async (_service: string, _method: string, _args: unknown[]) => ({
      bundle: "workspace-bundle",
    }));
    const loadImport = createEvalImportLoader(createBuildServiceClient(call), "worker", {
      defaultWorkspaceRef: "ctx:eval-context",
    });

    for (const ref of ["main", "ctx:other", "state:abc123"]) {
      await loadImport("@workspace/pkg", ref, []);
    }

    expect(call.mock.calls.map((entry) => entry[2][1])).toEqual([
      "main",
      "ctx:other",
      "state:abc123",
    ]);
  });

  it("probes manifest-declared unscoped workspace units without building them", async () => {
    const call = vi.fn(async (_service: string, method: string) => {
      if (method === "inspectBuildProvenance") {
        return {
          source: "local-worker",
          found: true,
          workspaceRoot: "/workspace",
          unit: { name: "local-worker", kind: "worker", relativePath: "workers/local-worker" },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const loadImport = createEvalImportLoader(createBuildServiceClient(call), "worker");

    await expect(loadImport.resolveWorkspaceImport("local-worker")).resolves.toBe(true);
    expect(call).toHaveBeenCalledWith("build", "inspectBuildProvenance", ["local-worker"]);
  });

  it("probes the package root for workspace export subpaths", async () => {
    const call = vi.fn(async () => ({
      source: "@workspace/pkg",
      found: true,
      workspaceRoot: "/workspace",
    }));
    const loadImport = createEvalImportLoader(createBuildServiceClient(call), "panel");

    await expect(loadImport.resolveWorkspaceImport("@workspace/pkg/report")).resolves.toBe(true);
    expect(call).toHaveBeenCalledWith("build", "inspectBuildProvenance", ["@workspace/pkg"]);
  });

  it("does not claim missing or ambiguous workspace units", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ source: "left-pad", found: false, workspaceRoot: "/workspace" })
      .mockResolvedValueOnce({
        source: "store",
        found: false,
        ambiguous: true,
        workspaceRoot: "/workspace",
        candidates: [],
      });
    const loadImport = createEvalImportLoader(createBuildServiceClient(call), "worker");

    await expect(loadImport.resolveWorkspaceImport("left-pad")).resolves.toBe(false);
    await expect(loadImport.resolveWorkspaceImport("store")).resolves.toBe(false);
  });

  it("rejects full builds for library imports", async () => {
    const call = vi.fn(async () => ({
      dir: "/tmp/build",
      sourceStateHash: null,
      metadata: {
        kind: "package" as const,
        name: "@workspace/pkg",
        sourceDigest: "source-digest-test",
        sourceStateHash: null,
        sourcemap: false,
        details: { kind: "package" },
        builtAt: "2026-07-13T00:00:00.000Z",
      },
      artifacts: [],
    }));
    const loadImport = createEvalImportLoader(createBuildServiceClient(call), "worker");

    await expect(loadImport("@workspace/pkg", undefined, [])).rejects.toThrow(
      "Build service returned a full build for library import: @workspace/pkg"
    );
  });
});
