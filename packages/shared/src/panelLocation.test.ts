import { describe, expect, it } from "vitest";
import {
  createPanelDeepLink,
  createPanelShareUrl,
  parsePanelLocationLink,
  type PanelLocation,
} from "./panelLocation.js";

const LOCATION: PanelLocation = {
  source: "panels/chat",
  workspace: "dev workspace",
  ref: "state:abc123",
  contextId: "ctx-123",
  stateArgs: { initialPrompt: "hello # world", nested: { count: 2 } },
  name: "Research",
  focus: false,
  disposition: "child",
};

describe("panel location links", () => {
  it("round-trips the custom-scheme carrier without relying on URL support", () => {
    const link = createPanelDeepLink(LOCATION);
    const RealURL = URL;
    const original = globalThis.URL;
    globalThis.URL = function StubURL(input: string | URL, base?: string | URL): URL {
      if (String(input).startsWith("vibestudio:")) throw new Error("unsupported custom scheme");
      return base === undefined ? new RealURL(input) : new RealURL(input, base);
    } as unknown as typeof URL;
    try {
      expect(parsePanelLocationLink(link)).toEqual({
        kind: "ok",
        carrier: "scheme",
        location: LOCATION,
      });
    } finally {
      globalThis.URL = original;
    }
  });

  it("round-trips an HTTPS carrier with all state in the fragment", () => {
    const link = createPanelShareUrl(LOCATION);
    expect(link).toMatch(/^https:\/\/vibestudio\.app\/panel#/);
    expect(link).not.toContain("?");
    expect(parsePanelLocationLink(link)).toEqual({
      kind: "ok",
      carrier: "https",
      location: LOCATION,
    });
  });

  it("rejects unknown, duplicate, malformed, and incompatible parameters", () => {
    const link = createPanelDeepLink({ source: "about/server-logs" });
    for (const invalid of [
      `${link}&source=panels/chat`,
      `${link}&secret=nope`,
      link.replace("v=1", "v=2"),
      link.replace("about%2Fserver-logs", "not-a-source"),
      `${link}&focus=maybe`,
      `${link}&disposition=popup`,
    ]) {
      expect(parsePanelLocationLink(invalid).kind).toBe("error");
    }
  });

  it("requires stateArgs to be an object and serializable", () => {
    expect(
      parsePanelLocationLink("vibestudio://panel?v=1&source=panels%2Fchat&stateArgs=%5B1%2C2%5D")
        .kind
    ).toBe("error");
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => createPanelDeepLink({ source: "panels/chat", stateArgs: cyclic })).toThrow(
      /finite JSON values/
    );
    expect(() =>
      createPanelDeepLink({ source: "panels/chat", stateArgs: { omitted: undefined } })
    ).toThrow(/finite JSON values/);
  });
});
