import { describe, expect, it } from "vitest";
import { normalizeSandboxSendOptions } from "./sandboxSend.js";

describe("normalizeSandboxSendOptions", () => {
  it("preserves structured interaction metadata", () => {
    const metadata = {
      interaction: {
        source: "onboarding-setup-hub",
        kind: "onboarding-capability",
        action: "setup",
        targetId: "connection.github",
      },
    };

    expect(
      normalizeSandboxSendOptions(
        { idempotencyKey: "chosen", tier: "primary", metadata },
        "fallback"
      )
    ).toEqual({
      idempotencyKey: "chosen",
      tier: "primary",
      metadata,
    });
  });
});
