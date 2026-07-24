import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { describe, expect, it } from "vitest";
import { createCorsApprovalService } from "./corsApprovalService.js";

function panelCaller() {
  return createVerifiedCaller("panel-1", "panel", {
    callerId: "panel-1",
    callerKind: "panel",
    repoPath: "panels/chat",
    effectiveVersion: "version-1",
    executionDigest: "a".repeat(64),
    requested: [
      {
        capability: "network.response.read",
        resource: { kind: "origin", origin: "https://api.example.com" },
      },
    ],
  });
}

describe("corsApprovalService", () => {
  it("selects one semantic approval leaf for the exact response origin", async () => {
    const service = createCorsApprovalService();
    const prepare = service.authorityPreparation?.["corsApproval.authorize.target"];
    expect(
      prepare?.({ caller: panelCaller() }, [
        {
          targetUrl: "https://api.example.com/v1/models",
          requestOrigin: "http://localhost:9100",
        },
      ])
    ).toEqual([
      expect.objectContaining({
        capability: "network.response.read",
        resourceKey: "https://api.example.com",
      }),
    ]);
  });

  it("reports the dispatcher decision without running a second approval path", async () => {
    const service = createCorsApprovalService();
    await expect(
      service.handler(
        {
          caller: panelCaller(),
          authorityDecisions: new Map([["network.response.read", "session"]]),
        },
        "authorize",
        [{ targetUrl: "https://api.example.com/v1/models" }]
      )
    ).resolves.toEqual({ allowed: true, decision: "session" });
  });

  it("rejects invalid targets before prompting", async () => {
    const service = createCorsApprovalService();
    const prepare = service.authorityPreparation?.["corsApproval.authorize.target"];
    expect(() => prepare?.({ caller: panelCaller() }, [{ targetUrl: "file:///tmp/data" }])).toThrow(
      "CORS target must be an http(s) URL"
    );
  });
});
