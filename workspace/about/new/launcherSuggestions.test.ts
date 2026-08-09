import { describe, expect, it } from "vitest";
import {
  parsePanelUsage,
  rankLaunchablePanels,
  recordPanelUsage,
  serializePanelUsage,
} from "./launcherSuggestions";

const panels = [
  { path: "panels/chat", title: "Chat" },
  { path: "panels/terminal", title: "Terminal" },
  { path: "about/history", title: "History" },
];

describe("launcher panel suggestions", () => {
  it("ranks the default shortlist by frequency, recency, then title", () => {
    expect(
      rankLaunchablePanels(
        panels,
        "",
        {
          "panels/chat": { count: 2, lastUsed: 100 },
          "panels/terminal": { count: 2, lastUsed: 200 },
          "about/history": { count: 5, lastUsed: 50 },
        },
        3
      ).map((panel) => panel.path)
    ).toEqual(["about/history", "panels/terminal", "panels/chat"]);
  });

  it("prioritizes match quality before usage while filtering", () => {
    expect(
      rankLaunchablePanels(
        panels,
        "history",
        { "panels/chat": { count: 1_000, lastUsed: 999 } },
        5
      ).map((panel) => panel.path)
    ).toEqual(["about/history"]);
  });

  it("records and validates the versioned usage projection", () => {
    const usage = recordPanelUsage({}, "panels/chat", 100);
    const twice = recordPanelUsage(usage, "panels/chat", 200);
    expect(parsePanelUsage(serializePanelUsage(twice))).toEqual({
      "panels/chat": { count: 2, lastUsed: 200 },
    });
    expect(parsePanelUsage('{"version":0}')).toEqual({});
    expect(
      parsePanelUsage(
        JSON.stringify({ version: 1, panels: { "panels/chat": { count: "many", lastUsed: 1 } } })
      )
    ).toEqual({});
  });
});
