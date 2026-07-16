import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { describe, expect, it } from "vitest";
import { createCorsApprovalService } from "./corsApprovalService.js";

describe("corsApprovalService", () => {
  it.each(["panel", "app", "worker", "do"] as const)(
    "returns the dispatcher-owned authority decision for a verified %s caller",
    async (kind) => {
      const service = createCorsApprovalService();
      await expect(
        service.handler(
          {
            caller: createVerifiedCaller(`${kind}:caller`, kind),
            authorityDecisions: new Map([["cors-response-read", "session"]]),
          },
          "authorize",
          [
            {
              targetUrl: "https://api.example.com/v1/models",
              requestOrigin: "http://localhost:9100",
            },
          ]
        )
      ).resolves.toEqual({ allowed: true, decision: "session" });
    }
  );

  it("does not invent an approval when the dispatcher supplied no decision", async () => {
    const service = createCorsApprovalService();
    await expect(
      service.handler({ caller: createVerifiedCaller("panel:one", "panel") }, "authorize", [
        { targetUrl: "https://api.example.com/v1/models" },
      ])
    ).resolves.toEqual({ allowed: true });
  });

  it("rejects unsupported callers and non-http targets", async () => {
    const service = createCorsApprovalService();
    await expect(
      service.handler({ caller: createVerifiedCaller("shell:one", "shell") }, "authorize", [
        { targetUrl: "https://api.example.com" },
      ])
    ).rejects.toMatchObject({ code: "EACCES" });
    await expect(
      service.handler({ caller: createVerifiedCaller("panel:one", "panel") }, "authorize", [
        { targetUrl: "file:///etc/passwd" },
      ])
    ).resolves.toEqual({ allowed: false, reason: "CORS target must be an http(s) URL" });
  });
});
