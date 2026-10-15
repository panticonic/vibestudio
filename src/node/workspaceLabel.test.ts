import { describe, expect, it } from "vitest";
import { workspaceLabel } from "./workspaceLabel.js";

describe("workspaceLabel", () => {
  it("names the private pair by role, never by its internal name", () => {
    expect(workspaceLabel({ name: "personal-ws_abc", privateRole: "personal" })).toBe("Personal");
    expect(
      workspaceLabel({ name: "system-ws_abc", displayName: "Tools", privateRole: "system" })
    ).toBe("System");
  });

  it("shows another workspace's display name, else its name", () => {
    expect(workspaceLabel({ name: "lab", displayName: "Research lab" })).toBe("Research lab");
    expect(workspaceLabel({ name: "lab" })).toBe("lab");
  });
});
