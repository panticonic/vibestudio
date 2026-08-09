import { describe, expect, it, vi } from "vitest";
import { createAffectedBuildGate } from "./build.js";

const STATE = { kind: "event", eventId: "event-1" };

function context(packageJson: string | null) {
  const call = vi.fn(async (_target: string, method: string, ...args: unknown[]) => {
    if (method === "vcs.status") {
      return { workingHead: STATE };
    }
    if (method === "vcs.listDirectory") {
      const input = args[0] as { path: string };
      if (input.path === "") {
        return {
          entries: [{ path: "about", kind: "directory", repositoryRoot: false }],
          nextCursor: null,
        };
      }
      if (input.path === "about") {
        return {
          entries: [{ path: "about/help", kind: "directory", repositoryRoot: true }],
          nextCursor: null,
        };
      }
      throw new Error(`unexpected directory ${input.path}`);
    }
    if (method === "vcs.resolveRepository") {
      return { repositoryId: "repo-about-help", repoPath: "about/help" };
    }
    if (method === "vcs.readFile") {
      return packageJson === null
        ? null
        : {
            content: { kind: "text", text: packageJson },
          };
    }
    if (method === "build.getBuild") {
      return { ok: true };
    }
    throw new Error(`unexpected RPC ${method}`);
  });
  return { rpc: { call } };
}

describe("template composer affected build gate", () => {
  it("builds affected About pages", async () => {
    const ctx = context(JSON.stringify({ name: "@workspace/about-help" }));
    await expect(
      createAffectedBuildGate(ctx as never)("operation-1", ["about/help"])
    ).resolves.toEqual({ failures: [] });
    expect(ctx.rpc.call).toHaveBeenCalledWith(
      "main",
      "build.getBuild",
      "about/help",
      "ctx:operation-1"
    );
  });

  it("fails closed when an affected buildable repository has no package manifest", async () => {
    const ctx = context(null);
    await expect(
      createAffectedBuildGate(ctx as never)("operation-1", ["about/help"])
    ).resolves.toEqual({
      failures: [
        {
          unit: "about/help",
          message:
            "Cannot build affected unit about/help: package.json with a package name is required",
        },
      ],
    });
    expect(ctx.rpc.call).not.toHaveBeenCalledWith(
      "main",
      "build.getBuild",
      expect.anything(),
      expect.anything()
    );
  });

  it("accepts an intentionally removed prior unit instead of treating it as a malformed add", async () => {
    const ctx = context(null);
    await expect(
      createAffectedBuildGate(ctx as never, new Set(["about/help"]))("operation-1", [
        "about/help",
      ])
    ).resolves.toEqual({ failures: [] });
  });
});
