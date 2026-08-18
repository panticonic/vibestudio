import { describe, expect, it, vi } from "vitest";
import {
  createVerifiedCaller,
  ServiceDispatcher,
  type ServiceContext,
} from "@vibestudio/shared/serviceDispatcher";
import { createBaseReleaseService } from "./baseReleaseService.js";

const ctx: ServiceContext = { caller: createVerifiedCaller("shell", "shell") };
const target = {
  url: "git+https://github.com/panticonic/vibestudio-workspace-base.git",
  ref: "refs/tags/v0.3.10",
  commit: "b".repeat(40),
  snapshot: `v1-sha256:${"c".repeat(64)}` as const,
};
const installed = {
  nodeId: "base-node",
  alias: "vibestudio-workspace-base",
  url: target.url,
  ref: "refs/tags/v0.3.9",
  commit: "a".repeat(40),
  direct: true,
  state: "current" as const,
  contributedParts: 100,
  pendingReviews: 0,
  suggestions: [],
};

describe("baseRelease service", () => {
  const systemSubject = { userId: "usr_system", handle: "system" };

  it("registers every method with a reviewed tier decision", () => {
    const dispatcher = new ServiceDispatcher();
    const service = createBaseReleaseService({ target, dispatcher, systemSubject });

    expect(() => dispatcher.registerService(service)).not.toThrow();
    expect(dispatcher.getMethodSchema("baseRelease", "check")?.tier).toMatchObject({
      tier: "open",
      residency: "supervision",
      family: "workspace.base-release",
    });
  });

  it("compares the installed Base lineage with the verified host pin", async () => {
    const dispatch = vi.fn(async () => [installed]);
    const service = createBaseReleaseService({
      target,
      dispatcher: { dispatch },
      systemSubject,
    });

    await expect(service.handler(ctx, "check", [])).resolves.toEqual({
      alias: installed.alias,
      installed,
      target,
      updateAvailable: true,
    });
  });

  it("hands the exact host pin to Composer's ordinary pull operation", async () => {
    const operation = {
      operationId: "base-release-1",
      initiator: "host-release" as const,
      target: { alias: installed.alias, ref: target.ref },
      state: "pending" as const,
      affectedParts: ["extensions/browser-data"],
    };
    const dispatch = vi.fn(async (_ctx, _service, _method, args) =>
      (args as unknown[])[1] === "status" ? [installed] : operation
    );
    const service = createBaseReleaseService({
      target,
      dispatcher: { dispatch },
      systemSubject,
    });

    await expect(
      service.handler(ctx, "pull", [{ commandId: "base-release-1" }])
    ).resolves.toMatchObject({ initiator: "host-release", state: "pending" });
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        caller: expect.objectContaining({
          runtime: { id: "server", kind: "server" },
          hostOriginated: true,
        }),
      }),
      "extensions",
      "invoke",
      [
        "@workspace-extensions/template-composer",
        "pull",
        [{ commandId: "base-release-1", alias: installed.alias, pin: target }],
      ]
    );
  });

  it("fails instead of treating another template as Base lineage", async () => {
    const service = createBaseReleaseService({
      target,
      dispatcher: {
        dispatch: vi.fn(async () => [{ ...installed, url: "git+https://example.com/other.git" }]),
      },
      systemSubject,
    });

    await expect(service.handler(ctx, "check", [])).rejects.toThrow(
      "no installed Vibestudio Base lineage"
    );
  });
});
