import { describe, expect, it } from "vitest";
import {
  browserUrlFromPanelSource,
  buildPanelChromeState,
  classifyPanelUrl,
  collectBrowserAddressSuggestionsFromPanels,
  mergeBrowserAddressSuggestions,
  normalizeBrowserAddressSuggestions,
  isBrowserPanelSource,
  isOpenPanelBrowserUrl,
  parseAddressInput,
  parsePanelBuildCoordinate,
  panelSourceFromBrowserUrl,
  splitTextByMatchRanges,
} from "./panelChrome.js";
import type { Panel } from "./types.js";

function makePanel(source: string): Panel {
  const snapshot = {
    source,
    contextId: "ctx-1",
    options: {},
  };
  return {
    id: "panel-1",
    title: "Panel",
    children: [],
    snapshot,
    artifacts: { buildState: "ready" },
  };
}

function makePanelAtRef(source: string, ref: string): Panel {
  const panel = makePanel(source);
  return {
    ...panel,
    snapshot: {
      ...panel.snapshot,
      options: { ...panel.snapshot.options, ref },
    },
  };
}

describe("panelChrome", () => {
  it("recognizes browser panel sources", () => {
    expect(isBrowserPanelSource("browser:https://example.com")).toBe(true);
    expect(browserUrlFromPanelSource("browser:https://example.com")).toBe("https://example.com");
    expect(panelSourceFromBrowserUrl("https://example.com")).toBe("browser:https://example.com");
    expect(isBrowserPanelSource("panels/chat")).toBe(false);
  });

  it("recognizes URLs that openPanel should route to browser panels", () => {
    expect(isOpenPanelBrowserUrl("https://example.com")).toBe(true);
    expect(isOpenPanelBrowserUrl("http://example.com")).toBe(true);
    expect(isOpenPanelBrowserUrl("data:text/html,<button>Click</button>")).toBe(true);
    expect(
      isOpenPanelBrowserUrl("blob:https://example.com/00000000-0000-0000-0000-000000000000")
    ).toBe(true);
    expect(isOpenPanelBrowserUrl("about:blank")).toBe(true);
    expect(isOpenPanelBrowserUrl("about:blank#ready")).toBe(true);
    expect(isOpenPanelBrowserUrl("panels/chat")).toBe(false);
    expect(isOpenPanelBrowserUrl("javascript:alert(1)")).toBe(false);
  });

  it("classifies panel, managed, OS, and refused schemes centrally", () => {
    expect(classifyPanelUrl("https://example.com")).toEqual({
      disposition: "browser-panel",
      scheme: "https:",
    });
    expect(classifyPanelUrl("vibestudio://panel?v=1&source=about%2Fhelp")).toEqual({
      disposition: "managed",
      scheme: "vibestudio:",
    });
    expect(classifyPanelUrl("mailto:hello@example.com")).toEqual({
      disposition: "external",
      scheme: "mailto:",
    });
    expect(classifyPanelUrl("tel:+4912345")).toEqual({
      disposition: "external",
      scheme: "tel:",
    });
    expect(classifyPanelUrl("file:///etc/passwd")).toMatchObject({
      disposition: "refused",
      scheme: "file:",
    });
    expect(classifyPanelUrl("javascript:alert(1)")).toMatchObject({
      disposition: "refused",
      scheme: "javascript:",
    });
    expect(classifyPanelUrl("about:config")).toMatchObject({
      disposition: "refused",
      scheme: "about:",
    });
  });

  it("parses address input into panel sources, urls, or searches", () => {
    expect(parseAddressInput("panels/chat")).toEqual({
      type: "panel-source",
      source: "panels/chat",
    });
    expect(parseAddressInput("example.com")).toEqual({
      type: "browser-url",
      url: "https://example.com",
    });
    expect(parseAddressInput("https://example.com/path")).toEqual({
      type: "browser-url",
      url: "https://example.com/path",
    });
    expect(parseAddressInput("hello world")).toEqual({ type: "search", query: "hello world" });
    expect(
      parseAddressInput(
        "vibestudio://panel?v=1&source=panels%2Fchat&contextId=ctx-1&disposition=child"
      )
    ).toEqual({
      type: "panel-location",
      location: {
        source: "panels/chat",
        contextId: "ctx-1",
        disposition: "child",
      },
    });
  });

  it("builds browser and panel chrome state", () => {
    expect(
      buildPanelChromeState({
        panel: makePanel("browser:https://example.com"),
        navigation: { url: "https://example.com/docs", canGoBack: true, isLoading: true },
      })
    ).toMatchObject({
      kind: "browser",
      displayAddress: "https://example.com/docs",
      editableAddress: "https://example.com/docs",
      resolvedUrl: "https://example.com/docs",
      canGoBack: true,
      isLoading: true,
    });

    expect(
      buildPanelChromeState({
        panel: makePanel("panels/chat"),
      })
    ).toMatchObject({
      kind: "panel",
      displayAddress: "panels/chat",
    });
  });

  it("parses the complete panel build-coordinate vocabulary", () => {
    expect(parsePanelBuildCoordinate()).toEqual({ kind: "main" });
    expect(parsePanelBuildCoordinate("ctx:review")).toEqual({
      kind: "context",
      contextId: "review",
    });
    expect(parsePanelBuildCoordinate(`state:${"b".repeat(64)}`)).toEqual({
      kind: "content",
      workspaceStateHash: `state:${"b".repeat(64)}`,
    });
    expect(() => parsePanelBuildCoordinate("feature-branch")).toThrow(
      /Unsupported panel build coordinate/
    );
    expect(() => parsePanelBuildCoordinate("ctx:not canonical")).toThrow(
      /Unsupported panel build coordinate/
    );
  });

  it("labels content-addressed build coordinates instead of displaying bare hashes", () => {
    expect(
      buildPanelChromeState({
        panel: makePanelAtRef("panels/chat", `state:${"c".repeat(64)}`),
      }).displayAddress
    ).toBe("panels/chat @ content state cccccccccc…");
  });

  it("normalizes and ranks browser address suggestions", () => {
    const history = normalizeBrowserAddressSuggestions([
      {
        url: "https://example.com/docs",
        title: "Docs",
        visit_count: 3,
        typed_count: 1,
        last_visit: 100,
      },
      { url: "https://example.com/docs", title: "Duplicate" },
    ]);
    const session = collectBrowserAddressSuggestionsFromPanels([
      { ...makePanel("browser:https://example.com/app"), title: "App" },
    ]);

    expect(history).toEqual([
      expect.objectContaining({
        url: "https://example.com/docs",
        title: "Docs",
        source: "history",
      }),
    ]);
    expect(
      mergeBrowserAddressSuggestions([history, session], "example", 5).map((item) => item.url)
    ).toEqual(["https://example.com/app", "https://example.com/docs"]);
  });

  it("splits text for shared suggestion highlighting", () => {
    expect(
      splitTextByMatchRanges("Example Docs", [
        { start: 0, end: 7 },
        { start: 8, end: 12 },
      ])
    ).toEqual([
      { text: "Example", highlighted: true },
      { text: " ", highlighted: false },
      { text: "Docs", highlighted: true },
    ]);
    expect(splitTextByMatchRanges("Example", [{ start: 2, end: 99 }])).toEqual([
      { text: "Ex", highlighted: false },
      { text: "ample", highlighted: true },
    ]);
  });
});
