import { describe, expect, it } from "vitest";
import { WorkspaceAutomationSchema } from "./automations.js";

const automation = (tool: string) => ({
  source: "workers/news-agent",
  className: "NewsAgent",
  name: "Refresh news",
  summary: "Refresh the current news briefing",
  action: { kind: "tool", tool, args: { briefing: false } },
  trigger: { kind: "manual" },
  operations: [],
});

describe("workspace automation tool action schema", () => {
  it("preserves namespaced selected tool names exactly", () => {
    const result = WorkspaceAutomationSchema.parse(
      automation("vibestudio.refresh-now"),
    );
    expect(result.action).toEqual({
      kind: "tool",
      tool: "vibestudio.refresh-now",
      args: { briefing: false },
    });
  });

  it.each(["", "   ", "x".repeat(129)])(
    "rejects an invalid selected tool name (%j)",
    (tool) => {
      expect(WorkspaceAutomationSchema.safeParse(automation(tool)).success).toBe(
        false,
      );
    },
  );
});
