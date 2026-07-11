import { afterEach, describe, expect, it, vi } from "vitest";
import { GIT_INTEROP_PROVIDER_METHOD_NAMES } from "@vibestudio/shared/serviceSchemas/gitInterop";
import { activate } from "./index.js";
import { UpstreamEngine } from "./upstream.js";

describe("git-bridge activation surface", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes Git transport only through its provider namespace", async () => {
    vi.spyOn(UpstreamEngine.prototype, "activate").mockResolvedValue(undefined);
    const rpc = { call: vi.fn(async () => ({ ok: true })) };
    const api = await activate({
      name: "@workspace-extensions/git-bridge",
      log: { info: vi.fn(), warn: vi.fn() },
      rpc,
    } as never);

    expect(Object.keys(api.providerContracts.gitInterop)).toEqual(
      GIT_INTEROP_PROVIDER_METHOD_NAMES
    );
    expect(api).not.toHaveProperty("pushUpstream");
    expect(api).not.toHaveProperty("publishRepo");
  });

  it("routes notification actions back through the host-owned Git service", async () => {
    vi.spyOn(UpstreamEngine.prototype, "activate").mockResolvedValue(undefined);
    const rpc = { call: vi.fn(async () => ({ ok: true })) };
    const api = await activate({
      name: "@workspace-extensions/git-bridge",
      log: { info: vi.fn(), warn: vi.fn() },
      rpc,
    } as never);

    await api.retryUpstreamPush("projects/demo");
    await api.pauseAutoPush("projects/demo");

    expect(rpc.call).toHaveBeenNthCalledWith(1, "main", "gitInterop.pushUpstream", "projects/demo");
    expect(rpc.call).toHaveBeenNthCalledWith(
      2,
      "main",
      "gitInterop.setAutoPush",
      "projects/demo",
      false
    );
  });
});
