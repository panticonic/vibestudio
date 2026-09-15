import { describe, expect, it } from "vitest";
import {
  createPanelDeepLink,
  createPanelShareUrl,
  parsePanelLocationLink,
  resolvePanelWorkspace,
  type PanelLocation,
} from "./panelLocation.js";

const LOCATION: PanelLocation = {
  source: "panels/chat",
  workspace: "dev workspace",
  ref: "state:abc123",
  contextId: "ctx-123",
  stateArgs: { initialPrompt: "hello # world", nested: { count: 2 } },
  title: "Research",
  slug: "research",
  focus: false,
  disposition: "child",
  placement: { disposition: "side", preferredWidth: 640, minWidth: 440 },
};

describe("panel location links", () => {
  it.each([{ id: "ws-123" }, { role: "system" as const }, { role: "personal" as const }])(
    "round-trips typed workspace selector %j on both carriers",
    (workspace) => {
      const location = { source: "about/automations", workspace, stateArgs: { tab: "active" } };
      for (const create of [createPanelDeepLink, createPanelShareUrl]) {
        expect(parsePanelLocationLink(create(location))).toMatchObject({ kind: "ok", location });
      }
    }
  );

  it("resolves names, IDs, and private roles without confusing them", () => {
    const entries = [
      { workspaceId: "ws-private", name: "My tools", privateRole: "system" as const },
      { workspaceId: "ws-project", name: "ws-private" },
    ];
    expect(resolvePanelWorkspace({ role: "system" }, entries)).toBe(entries[0]);
    expect(resolvePanelWorkspace({ id: "ws-private" }, entries)).toBe(entries[0]);
    expect(resolvePanelWorkspace("ws-private", entries)).toBe(entries[1]);
    expect(resolvePanelWorkspace(undefined, entries, "ws-project")).toBe(entries[1]);
    expect(() => resolvePanelWorkspace({ role: "personal" }, entries)).toThrow(/unavailable/);
    expect(() => resolvePanelWorkspace("missing", entries, "ws-project")).toThrow(/unavailable/);
    expect(() =>
      resolvePanelWorkspace("same", [
        { workspaceId: "a", name: "same" },
        { workspaceId: "b", name: "same" },
      ])
    ).toThrow(/ambiguous/);
  });
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
      link.replace("about%2Fserver-logs", "..%2Fescape"),
      `${link}&focus=maybe`,
      `${link}&disposition=popup`,
      `${link}&placement=popup`,
      `${link}&preferredWidth=wide`,
      `${link}&minWidth=0`,
      `${link}&workspaceKind=role`,
      `${link}&workspaceKind=unknown&workspace=x`,
      `${link}&workspaceKind=role&workspace=admin`,
    ]) {
      expect(parsePanelLocationLink(invalid).kind).toBe("error");
    }
  });
  it("rejects ambiguous or malformed workspace objects", () => {
    for (const workspace of [
      { id: "x", role: "system" },
      { role: "admin" },
      { id: "" },
      {},
      [],
      null,
    ]) {
      expect(() =>
        createPanelDeepLink({ source: "panels/chat", workspace } as PanelLocation)
      ).toThrow(/workspace/);
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
