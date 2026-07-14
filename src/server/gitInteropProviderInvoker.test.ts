import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { describe, expect, it, vi } from "vitest";
import { createGitInteropProviderInvoker } from "./gitInteropProviderInvoker.js";

const ctx = { caller: createVerifiedCaller("server", "server") };

describe("Git interop provider dispatch", () => {
  it("routes through the manifest provider slot with validated wire values", async () => {
    const host = { invokeProvider: vi.fn(async () => []) };
    const invoke = createGitInteropProviderInvoker(() => host);

    await expect(invoke(ctx, "upstreamStatus", [[]])).resolves.toEqual([]);
    expect(host.invokeProvider).toHaveBeenCalledWith(ctx, "gitInterop", "upstreamStatus", [[]]);
  });

  it("rejects malformed arguments before invoking the provider", async () => {
    const host = { invokeProvider: vi.fn(async () => undefined) };
    const invoke = createGitInteropProviderInvoker(() => host);

    await expect(
      invoke(ctx, "pushUpstream", ["projects/demo", undefined] as never)
    ).rejects.toThrow("Invalid gitInterop provider pushUpstream arguments");
    expect(host.invokeProvider).not.toHaveBeenCalled();
  });

  it("rejects malformed provider results", async () => {
    const host = { invokeProvider: vi.fn(async () => ({ stateHash: "state:123" })) };
    const invoke = createGitInteropProviderInvoker(() => host);

    await expect(
      invoke(ctx, "prepareImport", [
        {
          operationId: "3e903582-72fb-4ca6-9238-809f74193d2a",
          repoPath: "projects/demo",
          remote: { name: "origin", url: "https://example.test/demo.git", branch: "main" },
        },
      ])
    ).rejects.toThrow("Invalid gitInterop provider prepareImport result");
  });

  it("fails before dispatch when the extension host is unavailable", async () => {
    const invoke = createGitInteropProviderInvoker(() => null);

    await expect(invoke(ctx, "onMainAdvanced", [["projects/demo"]])).rejects.toThrow(
      "Git upstream provider is unavailable: extension host not started"
    );
  });
});
