import { describe, expect, it } from "vitest";
import {
  autocompleteForSuggestion,
  buildLauncherSuggestions,
  isLikelyAgentPrompt,
  parseLauncherInput,
} from "./launcherSuggestions";

const panels = [
  { path: "panels/chat", title: "Chat" },
  { path: "panels/terminal", title: "Terminal" },
  { path: "about/history", title: "History" },
];
const history = [
  {
    id: 1,
    url: "https://example.com/docs",
    title: "Example Docs",
    visitCount: 12,
    typedCount: 3,
    lastVisit: 100,
  },
];

describe("launcher suggestions", () => {
  it("parses explicit panel, history, and chat modes", () => {
    expect(parseLauncherInput("> term")).toEqual({ mode: "panels", prefix: ">", query: "term" });
    expect(parseLauncherInput("@example").mode).toBe("history");
    expect(parseLauncherInput("/ explain this")).toEqual({
      mode: "chat",
      prefix: "/",
      query: "explain this",
    });
  });

  it("ranks panel and browser destinations in one usage-weighted list", () => {
    const suggestions = buildLauncherSuggestions({
      value: "",
      panels,
      panelUsage: {
        "panels/terminal": { count: 30, lastUsed: 200 },
        "about/history": { count: 2, lastUsed: 100 },
      },
      browserSuggestions: history,
      browserUrl: null,
    });
    expect(suggestions[0]?.id).toBe("panel:panels/terminal");
    expect(suggestions.some((item) => item.kind === "history")).toBe(true);
  });

  it("prefers sentence-like chat unless a destination is an exact or prefix match", () => {
    expect(isLikelyAgentPrompt("Please investigate this issue for me")).toBe(true);
    const prompt = buildLauncherSuggestions({
      value: "please investigate this issue",
      panels: [{ path: "panels/investigate", title: "Investigate" }],
      panelUsage: {},
      browserSuggestions: [],
      browserUrl: null,
    });
    expect(prompt[0]?.kind).toBe("chat");

    const weakSubstring = buildLauncherSuggestions({
      value: "please write a report",
      panels: [{ path: "panels/report-tools", title: "Tools to please write a report" }],
      panelUsage: { "panels/report-tools": { count: 10_000, lastUsed: 999 } },
      browserSuggestions: [],
      browserUrl: null,
    });
    expect(weakSubstring[0]?.kind).toBe("chat");

    const exact = buildLauncherSuggestions({
      value: "terminal",
      panels,
      panelUsage: {},
      browserSuggestions: [],
      browserUrl: null,
    });
    expect(exact[0]?.id).toBe("panel:panels/terminal");
  });

  it("limits explicit modes to their destination type", () => {
    const panelOnly = buildLauncherSuggestions({
      value: ">",
      panels,
      panelUsage: {},
      browserSuggestions: history,
      browserUrl: null,
    });
    expect(panelOnly.every((item) => item.kind === "panel")).toBe(true);
    const chatOnly = buildLauncherSuggestions({
      value: "/hello there",
      panels,
      panelUsage: {},
      browserSuggestions: history,
      browserUrl: null,
    });
    expect(chatOnly.map((item) => item.kind)).toEqual(["chat"]);
  });

  it("offers inline completion for a selected prefix destination", () => {
    const suggestion = buildLauncherSuggestions({
      value: ">term",
      panels,
      panelUsage: {},
      browserSuggestions: [],
      browserUrl: null,
    })[0];
    expect(autocompleteForSuggestion(">term", suggestion)).toEqual({
      value: ">Terminal",
      suffix: "inal",
    });
  });
});
