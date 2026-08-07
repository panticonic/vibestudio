import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createAuthorityService } from "./authorityService.js";

describe("authorityService", () => {
  it("forwards the inbound cancellation signal to an authority wait", async () => {
    const signal = new AbortController().signal;
    const awaitDecision = vi.fn(async () => ({ state: "closed" as const }));
    const service = createAuthorityService({
      dispatcher: { preflightAuthority: vi.fn() } as never,
      acquisitions: { awaitDecision } as never,
    });

    await expect(
      service.handler(
        { caller: createVerifiedCaller("agent:1", "agent"), signal },
        "awaitDecision",
        [{ acquisitionId: "acq:1" }]
      )
    ).resolves.toEqual({ state: "closed" });
    expect(awaitDecision).toHaveBeenCalledWith({
      acquisitionId: "acq:1",
      ownerRuntimeId: "agent:1",
      signal,
    });
  });
});
