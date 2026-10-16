import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { name: "Vibestudio" }, Menu: {} }));

import type { ClientLaunchEntries, SnapshotClient } from "@vibestudio/client-host-core";
import { ClientIntegration } from "./clientIntegration.js";
import { buildDockMenu, buildJumpList } from "./launchSurfaces.js";
import { ShortcutRegistry, type ShortcutRequest } from "./shortcutRegistry.js";
import { ClientBadges, ClientTrays } from "./trayBadge.js";

const clients: ClientLaunchEntries[] = [
  {
    clientId: "chat",
    title: "Chat",
    entries: [
      { clientId: "chat", intent: "open", label: "Chat", link: "vibestudio://c/chat/open" },
      {
        clientId: "chat",
        intent: "open-conversation",
        label: "Standup",
        link: "vibestudio://c/chat/open-conversation?channel=c1",
      },
    ],
  },
  { clientId: "idle", title: "Idle", entries: [] },
];

describe("dock menu and jump list", () => {
  it("lists each client's entries, then the open windows", () => {
    expect(buildDockMenu(clients, [{ clientId: "chat", title: "Chat" }])).toEqual([
      {
        kind: "client",
        clientId: "chat",
        title: "Chat",
        items: [
          { label: "Chat", link: "vibestudio://c/chat/open" },
          { label: "Standup", link: "vibestudio://c/chat/open-conversation?channel=c1" },
        ],
      },
      { kind: "open-windows", items: [{ label: "Chat", clientId: "chat" }] },
    ]);
    expect(buildDockMenu(clients, [])).toHaveLength(1);
  });

  it("builds one jump-list category per client with a task that starts the app with the link", () => {
    const [category, ...rest] = buildJumpList(clients, {
      command: ["C:\\App\\v.exe", "dev path"],
      iconPath: "i.png",
    });
    expect(rest).toEqual([]);
    expect(category).toMatchObject({ type: "custom", name: "Chat" });
    expect(category!.items[1]).toEqual({
      type: "task",
      title: "Standup",
      program: "C:\\App\\v.exe",
      args: '"dev path" vibestudio://c/chat/open-conversation?channel=c1',
      description: "Standup",
      iconPath: "i.png",
      iconIndex: 0,
    });
  });
});

describe("global shortcuts", () => {
  function registry(held: string[] = []) {
    const registered = new Map<string, () => void>();
    const run = vi.fn();
    const validate = vi.fn();
    const shortcuts = {
      register: vi.fn((accelerator: string, callback: () => void) => {
        if (held.includes(accelerator)) return false;
        registered.set(accelerator, callback);
        return true;
      }),
      unregister: vi.fn((accelerator: string) => void registered.delete(accelerator)),
    };
    return {
      registry: new ShortcutRegistry({ shortcuts, validate, run }),
      registered,
      run,
      validate,
      shortcuts,
    };
  }
  const ask: ShortcutRequest = { id: "ask", accelerator: "CmdOrCtrl+Shift+Space", intent: "ask" };

  it("registers a chord and runs the client's intent when it is pressed", () => {
    const t = registry();
    t.registry.register("chat", ask);
    t.registered.get(ask.accelerator)!();
    expect(t.run).toHaveBeenCalledWith("chat", ask);
    expect(t.registry.list("chat")).toEqual([ask]);
  });

  it("refuses a chord without a modifier, a held chord and another client's chord", () => {
    const t = registry(["Ctrl+H"]);
    expect(() => t.registry.register("chat", { ...ask, accelerator: "A" })).toThrow(/modifier/);
    expect(() => t.registry.register("chat", { ...ask, accelerator: "Ctrl+H" })).toThrow(
      /another application/
    );
    t.registry.register("chat", ask);
    expect(() => t.registry.register("other", { ...ask, id: "x" })).toThrow(
      /already registered by chat/
    );
  });

  it("replaces a registration of the same id, and releases everything of a client", () => {
    const t = registry();
    t.registry.register("chat", ask);
    t.registry.register("chat", { ...ask, accelerator: "CmdOrCtrl+Alt+K" });
    expect(t.registered.has(ask.accelerator)).toBe(false);
    t.registry.register("chat", { ...ask, id: "second", accelerator: "CmdOrCtrl+Alt+J" });
    t.registry.unregisterClient("chat");
    expect(t.registered.size).toBe(0);
    expect(t.registry.list("chat")).toEqual([]);
  });

  it("drops a registration whose intent the client no longer declares", () => {
    const t = registry();
    t.registry.register("chat", ask);
    t.validate.mockImplementation(() => {
      throw new Error("gone");
    });
    t.registry.revalidate();
    expect(t.registered.size).toBe(0);
  });
});

describe("tray and badge", () => {
  it("keeps one tray per client, routes its menu and click, and destroys it on clear", () => {
    const tray = { setToolTip: vi.fn(), setContextMenu: vi.fn(), on: vi.fn(), destroy: vi.fn() };
    const action = vi.fn();
    const activate = vi.fn();
    const buildMenu = vi.fn((_model, dispatch: (id: string) => void) => ({ dispatch }));
    const trays = new ClientTrays({ createTray: () => tray, buildMenu, activate, action });
    trays.set("chat", { tooltip: "Chat", items: [] });
    trays.set("chat", { items: [] });
    expect(tray.on).toHaveBeenCalledTimes(1);
    tray.on.mock.calls[0]![1]();
    expect(activate).toHaveBeenCalledWith("chat");
    (tray.setContextMenu.mock.calls[0]![0] as { dispatch(id: string): void }).dispatch("quit");
    expect(action).toHaveBeenCalledWith("chat", "quit");
    trays.clear("chat");
    expect(tray.destroy).toHaveBeenCalled();
    expect(trays.has("chat")).toBe(false);
  });

  it("sums what each client reports and forgets a client that goes", () => {
    const app = { setBadgeCount: vi.fn(() => true) };
    const badges = new ClientBadges(app);
    badges.set("a", 2);
    badges.set("b", 3);
    expect(app.setBadgeCount).toHaveBeenLastCalledWith(5);
    badges.clear("a");
    expect(app.setBadgeCount).toHaveBeenLastCalledWith(3);
    expect(() => badges.set("b", -1)).toThrow(/whole number/);
  });
});

describe("client integration", () => {
  const snapshot: SnapshotClient[] = [
    {
      id: "chat",
      title: "Chat",
      intents: [
        {
          name: "ask",
          kind: "background",
          params: { text: "text" },
          handler: "p#ask",
          title: "Ask",
        },
        { name: "open-conversation", kind: "foreground", params: { c: "string" } },
        { name: "bad", kind: "background" },
      ],
      entries: {},
    },
  ];

  function setup() {
    const ask = { open: vi.fn() };
    const deps = {
      fetchSnapshot: vi.fn(async () => ({ clients: snapshot })),
      launchers: { reconcile: vi.fn(async () => undefined) },
      shortcuts: () => ({ revalidate: vi.fn() }) as never,
      applySurfaces: vi.fn(),
      openForeground: vi.fn(),
      invokeBackground: vi.fn(async () => "pong"),
      ask,
    };
    return {
      integration: new ClientIntegration({ ...deps, launchers: deps.launchers as never }),
      deps,
      ask,
    };
  }

  it("applies the latest snapshot to launchers and OS surfaces, one refresh at a time", async () => {
    const { integration, deps } = setup();
    await Promise.all([integration.refresh(), integration.refresh()]);
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(deps.launchers.reconcile).toHaveBeenCalledTimes(2);
    expect(deps.applySurfaces.mock.calls.at(-1)![0][0].clientId).toBe("chat");
  });

  it("reports every projection that failed and still applied the others", async () => {
    const { integration, deps } = setup();
    deps.launchers.reconcile.mockRejectedValueOnce(new Error("disk full"));
    await expect(integration.refresh()).rejects.toThrow("disk full");
    expect(deps.applySurfaces).toHaveBeenCalled();
  });

  it("runs a shortcut's background intent through a compact ask window with the typed text", async () => {
    const { integration, deps, ask } = setup();
    await integration.refresh();
    integration.runShortcut("chat", { id: "a", accelerator: "Ctrl+K", intent: "ask" });
    const opened = ask.open.mock.calls[0]![0];
    expect(opened).toMatchObject({ clientId: "chat", title: "Ask" });
    await expect(opened.submit("ping")).resolves.toBe("pong");
    expect(deps.invokeBackground).toHaveBeenCalledWith({
      id: "chat",
      intent: "ask",
      params: { text: "ping" },
    });
  });

  it("opens a foreground intent in a compact window, and refuses what it cannot run", async () => {
    const { integration, deps } = setup();
    await integration.refresh();
    integration.runShortcut("chat", {
      id: "a",
      accelerator: "Ctrl+K",
      intent: "open-conversation",
      params: { c: "1" },
    });
    expect(deps.openForeground).toHaveBeenCalledWith("chat", {
      name: "open-conversation",
      params: { c: "1" },
    });
    expect(() =>
      integration.validateShortcut("chat", { id: "x", accelerator: "Ctrl+K", intent: "bad" })
    ).toThrow(/no text/);
    expect(() =>
      integration.validateShortcut("chat", { id: "x", accelerator: "Ctrl+K", intent: "nope" })
    ).toThrow(/no intent/);
  });
});
