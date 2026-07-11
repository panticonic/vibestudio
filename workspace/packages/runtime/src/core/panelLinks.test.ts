import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPanelDeepLink, buildPanelLink, buildPanelShareLink } from "./panelLinks.js";
import { parsePanelLocationLink } from "@vibestudio/shared/panelLocation";

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { __vibestudioGatewayConfig?: unknown }).__vibestudioGatewayConfig;
});

describe("buildPanelLink", () => {
  it("keeps the selected workspace route prefix in browser panel links", () => {
    vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:43873" } });
    (
      globalThis as {
        __vibestudioGatewayConfig?: { serverUrl: string };
      }
    ).__vibestudioGatewayConfig = {
      serverUrl: "http://localhost:43873/_workspace/dev-123",
    };

    expect(buildPanelLink("about/server-logs")).toBe("/_workspace/dev-123/about/server-logs/");
  });

  it("preserves ref, state, focus, and disposition in HTTP navigation links", () => {
    expect(
      buildPanelLink("panels/chat", {
        ref: "state:abc",
        stateArgs: { prompt: "hello" },
        focus: false,
        disposition: "current",
      })
    ).toBe(
      "/panels/chat/?ref=state%3Aabc&stateArgs=%7B%22prompt%22%3A%22hello%22%7D&focus=false&disposition=current"
    );
  });

  it("builds equivalent canonical deep and share links for the current workspace", () => {
    (
      globalThis as {
        __vibestudioGatewayConfig?: { serverUrl: string };
      }
    ).__vibestudioGatewayConfig = {
      serverUrl: "http://localhost:43873/_workspace/dev-123",
    };
    const options = {
      contextId: "ctx-1",
      stateArgs: { prompt: "hi" },
      disposition: "root" as const,
    };
    for (const link of [
      buildPanelDeepLink("panels/chat", options),
      buildPanelShareLink("panels/chat", options),
    ]) {
      expect(parsePanelLocationLink(link)).toMatchObject({
        kind: "ok",
        location: {
          source: "panels/chat",
          workspace: "dev-123",
          contextId: "ctx-1",
          stateArgs: { prompt: "hi" },
          disposition: "root",
        },
      });
    }
  });

  it("uses the explicitly injected workspace when the mobile facade URL has no route prefix", () => {
    (
      globalThis as {
        __vibestudioGatewayConfig?: { serverUrl: string; workspace: string };
      }
    ).__vibestudioGatewayConfig = {
      serverUrl: "http://127.0.0.1:43873",
      workspace: "mobile-workspace",
    };
    expect(parsePanelLocationLink(buildPanelShareLink("about/server-logs"))).toMatchObject({
      kind: "ok",
      location: { workspace: "mobile-workspace" },
    });
  });
});
