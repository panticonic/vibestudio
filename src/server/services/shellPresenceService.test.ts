import { describe, expect, it } from "vitest";

import { createShellPresenceService } from "./shellPresenceService.js";

describe("shellPresenceService", () => {
  it("allows dynamic shell apps to report presence", () => {
    const service = createShellPresenceService().definition;

    expect(service.authority.principals).toContain("code");
  });

  it("reports whether an approval-capable shell heartbeat is still reachable", () => {
    let now = 1_000;
    const service = createShellPresenceService({ now: () => now, defaultMaxAgeMs: 6_000 });

    expect(service.internal.status()).toEqual({
      reachable: false,
      activeApproverCount: 0,
      maxAgeMs: 6_000,
    });
    service.internal.markActive("shell:cli-watch");
    expect(service.internal.status()).toMatchObject({
      reachable: true,
      activeApproverCount: 1,
    });
    now += 6_001;
    expect(service.internal.status()).toMatchObject({
      reachable: false,
      activeApproverCount: 0,
    });
  });
});
