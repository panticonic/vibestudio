import { describe, expect, it } from "vitest";
import { missionsMethods } from "./missions.js";

describe("missions service agent ergonomics", () => {
  it("exposes safe lifecycle control to sessions while retaining human-only activation", () => {
    for (const method of ["edit", "runNow", "pause", "resume", "retire"] as const) {
      expect(missionsMethods[method].agentFacing).toBe(true);
      expect(missionsMethods[method].tier.session).toBe("family");
      expect(missionsMethods[method].authority?.principals).toContain("session");
    }
    expect(missionsMethods.requestReview.agentFacing).toBe(false);
    expect(missionsMethods.requestReview.tier.session).toBe("codeOnly");
    expect(missionsMethods.requestReview.authority?.principals).not.toContain("session");
  });

  it("provides one addressed read for a transcript tick inspector", () => {
    expect(missionsMethods.getRun.agentFacing).not.toBe(false);
    expect(missionsMethods.getRun.tier.session).toBe("family");
    expect(missionsMethods.getRun.description).toContain("exact automation run");
  });
});
