import { beforeEach, describe, expect, it, vi } from "vitest";

function createRpcCall() {
  return vi.fn(async (_target: string, method: string, args: unknown[]) => {
    switch (method) {
      case "panelTree.metadata":
        return {
          id: args[0],
          title: "Spectrolite",
          source: "panels/spectrolite",
          kind: "workspace",
          parentId: null,
          contextId: "ctx-vault",
          runtimeEntityId: "panel:spectrolite-entity",
          executionDigest: "ev-spectrolite",
        };
      case "panelTree.getStateArgs":
        return {
          repoRoot: "/workspace/docs",
          apiToken: "super-secret-token",
        };
      case "panelCdp.consoleHistory":
        return {
          entries: [
            {
              timestamp: 1,
              level: "error",
              message: "Fetch failed with Bearer abcdefghijklmnop",
              line: 10,
              sourceId: "index.tsx",
              url: "http://localhost/panels/spectrolite",
            },
          ],
          errors: [],
          dropped: { entries: 0, errors: 0 },
          capacity: { entries: 1000, errors: 500 },
        };
      case "panelTree.create":
        return {
          id: "debug-chat",
          title: "Agentic Chat",
          kind: "workspace",
          runtimeEntityId: "panel:debug-chat-entity",
          executionDigest: "ev-chat",
        };
      default:
        return undefined;
    }
  });
}

describe("panel error diagnostic chat launcher", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("opens a child chat with a redacted agent debugging prompt", async () => {
    const rpcCall = createRpcCall();
    const { _initPanelHandleBridge } = await import("./handle.js");
    const { openPanelErrorDiagnosticChat } = await import("./errorDebugChat.js");
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never, {
      selfId: "spectrolite",
      selfRpcTargetId: "panel:spectrolite-entity",
    });

    const result = await openPanelErrorDiagnosticChat(
      {
        surfaceName: "Spectrolite panel",
        errorName: "Error",
        errorMessage: "Maximum update depth exceeded",
        componentStack: "at SessionGate",
        locationHref: "http://localhost/panels/spectrolite",
        userAgent: "vitest",
        timestamp: "2026-06-15T00:00:00.000Z",
      },
      { slotId: "spectrolite", contextId: "ctx-fallback" }
    );

    expect(result).toMatchObject({ panelId: "debug-chat", title: "Agentic Chat" });
    expect(rpcCall).toHaveBeenCalledWith("main", "panelTree.create", [
      "panels/chat",
      expect.objectContaining({
        parentId: "spectrolite",
        focus: true,
        stateArgs: expect.objectContaining({
          contextId: "ctx-vault",
          initialPrompt: expect.stringContaining("Maximum update depth exceeded"),
        }),
      }),
    ]);
    expect(result.prompt).toContain("Inspect the failing panel source");
    expect(result.prompt).toContain("panels/spectrolite");
    expect(result.prompt).toContain('"apiToken": "[redacted]"');
    expect(result.prompt).toContain("Bearer [redacted]");
    expect(result.prompt).not.toContain("super-secret-token");
    expect(result.prompt).not.toContain("abcdefghijklmnop");
  });
});
