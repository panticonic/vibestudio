import { describe, expect, it, vi } from "vitest";
import { ClientWindows, type ClientWindow, type ClientWindowSpec } from "./clientWindow.js";

function spec(
  clientId: string,
  capabilities: ClientWindowSpec["capabilities"] = []
): ClientWindowSpec {
  return {
    clientId,
    principalId: `client:${clientId}:web:dev`,
    title: clientId,
    source: `clients/${clientId}`,
    buildKey: "bk",
    entryUrl: `vs-client://${clientId}/bk/index.html`,
    capabilities,
    codeIdentity: {
      source: `clients/${clientId}`,
      effectiveVersion: "ev",
      executionDigest: "a".repeat(64),
      requested: [],
    },
    workspaceId: "system",
  };
}

function setup() {
  const closed: Array<[string, string | null]> = [];
  const made: ClientWindow[] = [];
  const contents = new Map<string, { id: number; isDestroyed(): boolean }>();
  let next = 1;
  const make = (hostsPanels: boolean) => (windowId: string, s: ClientWindowSpec) => {
    const c = { id: next++, isDestroyed: () => false };
    contents.set(windowId, c);
    const window: ClientWindow = {
      windowId,
      callerId: hostsPanels ? `native:${windowId}` : windowId,
      spec: s,
      hostsPanels,
      contents: () => c as never,
      browserWindow: () => null,
      load: vi.fn(async () => undefined),
      show: vi.fn(),
      swap: vi.fn(),
      setCapabilities: vi.fn(),
      send: vi.fn(),
      close: vi.fn(() => windows.notifyClosed(window)),
    };
    made.push(window);
    return window;
  };
  const opened: string[] = [];
  let openFailure: Error | null = null;
  const windows: ClientWindows = new ClientWindows(
    { plain: make(false), panelHosting: make(true) },
    {
      opened: async (window) => {
        opened.push(window.windowId);
        if (openFailure) throw openFailure;
      },
      closed: (window, reason) => closed.push([window.windowId, reason]),
    }
  );
  return {
    windows,
    closed,
    made,
    opened,
    failOpening: (error: Error) => {
      openFailure = error;
    },
  };
}

describe("ClientWindows", () => {
  it("announces each new window to the host before open resolves, and fails the open when the host cannot hold it", async () => {
    const { windows, opened, failOpening } = setup();
    const window = await windows.open(spec("chat"));
    expect(opened).toEqual([window.windowId]);

    failOpening(new Error("no session"));
    await expect(windows.open(spec("chat"))).rejects.toThrow("no session");
    expect(windows.windowsOf("chat")).toEqual([window]);
  });

  it("registers a window before its document loads, so the document's connection finds its owner", async () => {
    const { windows, made } = setup();
    let ownerWhileLoading: ClientWindow | null = null;
    const opening = windows.open(spec("browser", ["panel-hosting"]));
    const window = made[0]!;
    vi.mocked(window.load).mockImplementation(async () => {
      ownerWhileLoading = windows.byWebContents(window.contents()!.id);
    });
    await opening;
    expect(ownerWhileLoading).toBe(window);
  });

  it("closes and forgets a window whose document could not load", async () => {
    const { windows, made, closed } = setup();
    const opening = windows.open(spec("chat"));
    vi.mocked(made[0]!.load).mockRejectedValue(new Error("load failed"));
    await expect(opening).rejects.toThrow("load failed");
    expect(windows.windowsOf("chat")).toEqual([]);
    expect(closed).toEqual([[made[0]!.windowId, "The window could not open"]]);
  });

  it("lets a client open several windows, each belonging to exactly one client", async () => {
    const { windows } = setup();
    const a1 = await windows.open(spec("chat"));
    const a2 = await windows.open(spec("chat"));
    const b1 = await windows.open(spec("notes"));
    expect(a1.windowId).not.toBe(a2.windowId);
    expect(windows.windowsOf("chat")).toEqual([a1, a2]);
    expect(windows.windowsOf("notes")).toEqual([b1]);
    expect(a1.spec.clientId).toBe("chat");
    expect(windows.byCaller(b1.callerId)).toBe(b1);
    expect(windows.byWebContents(b1.contents()!.id)).toBe(b1);
    expect(windows.byWebContents(999)).toBeNull();
  });

  it("gives the panel-hosting client one window: the panel surface has one place", async () => {
    const { windows, made } = setup();
    const first = await windows.open(spec("browser", ["panel-hosting"]));
    const again = await windows.open(spec("browser", ["panel-hosting"]));
    expect(again).toBe(first);
    expect(made).toHaveLength(1);
    expect(first.show).toHaveBeenCalled();
    expect(windows.panelHost()).toBe(first);
    await windows.open(spec("chat"));
    expect(windows.panelHost()).toBe(first);
  });

  it("attributes a close to the host only when the host asked for it", async () => {
    const { windows, closed } = setup();
    const person = await windows.open(spec("chat"));
    const host1 = await windows.open(spec("notes"));
    const host2 = await windows.open(spec("notes"));
    person.close();
    windows.closeClient("notes", "trust-revoked");
    expect(closed).toEqual([
      [person.windowId, null],
      [host1.windowId, "trust-revoked"],
      [host2.windowId, "trust-revoked"],
    ]);
    expect(windows.all()).toEqual([]);
    expect(windows.focus("notes")).toBe(false);
  });

  it("reports a window's end once, and focuses a client's latest window", async () => {
    const { windows, closed } = setup();
    const w1 = await windows.open(spec("chat"));
    const w2 = await windows.open(spec("chat"));
    expect(windows.focus("chat")).toBe(true);
    expect(w2.show).toHaveBeenCalled();
    expect(w1.show).not.toHaveBeenCalled();
    windows.notifyClosed(w1);
    windows.notifyClosed(w1);
    expect(closed).toHaveLength(1);
  });
});
