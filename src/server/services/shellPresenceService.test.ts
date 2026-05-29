import { describe, expect, it } from "vitest";

import { createShellPresenceService } from "./shellPresenceService.js";

describe("shellPresenceService", () => {
  it("allows dynamic shell apps to report presence", () => {
    const service = createShellPresenceService().definition;

    expect(service.policy?.allowed).toContain("app");
  });
});
