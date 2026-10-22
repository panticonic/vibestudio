import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setApplicationMenu: vi.fn(),
  buildFromTemplate: vi.fn((template: unknown) => ({ template, popup: vi.fn() })),
}));
vi.mock("electron", () => ({
  app: { name: "Vibestudio" },
  Menu: {
    setApplicationMenu: mocks.setApplicationMenu,
    buildFromTemplate: mocks.buildFromTemplate,
  },
}));

import {
  ClientMenus,
  acceleratorMatches,
  buildApplicationMenuTemplate,
  buildPopupTemplate,
  chromeOwnedItems,
  parseClientMenuModel,
  type ClientMenuModel,
} from "./clientMenu.js";

const model: ClientMenuModel = {
  menus: [
    {
      label: "Panel",
      items: [
        { id: "reload", label: "Reload", accelerator: "CmdOrCtrl+R", chromeOwned: true },
        { separator: true },
        { label: "More", submenu: [{ id: "zoom-in", label: "Zoom In" }] },
      ],
    },
  ],
  popup: [{ id: "settings", label: "Settings…" }],
  app: [{ id: "settings", label: "Settings…" }],
};

type Template = Array<{ label?: string; role?: string; submenu?: Template; click?: () => void }>;

describe("client menu model", () => {
  it("accepts a well-formed contribution and rejects anything a client could abuse", () => {
    expect(parseClientMenuModel(model)).toEqual(model);
    const bad: unknown[] = [
      { menus: [{ label: "X", items: [{ label: "no action" }] }] },
      {
        menus: [
          { label: "X", items: [{ id: "a", label: "A", submenu: [{ id: "b", label: "B" }] }] },
        ],
      },
      { menus: [{ label: "X", items: [{ role: "quit" }] }] },
      { menus: [{ label: "X", items: [{ id: "a", label: "A", accelerator: "Ctrl+Nope" }] }] },
      { menus: [{ label: "X", items: [{ id: "a", label: "A", chromeOwned: true }] }] },
      { menus: [{ label: "X", items: [{ id: "a", label: "A", click: "evil()" }] }] },
      { menus: Array.from({ length: 13 }, () => ({ label: "X", items: [] })) },
    ];
    for (const value of bad) expect(() => parseClientMenuModel(value)).toThrow();
  });

  it("matches accelerators the way each platform spells its primary modifier", () => {
    const press = (over: Partial<Electron.Input>): Electron.Input =>
      ({
        type: "keyDown",
        key: "r",
        control: false,
        shift: false,
        alt: false,
        meta: false,
        ...over,
      }) as Electron.Input;
    expect(acceleratorMatches("CmdOrCtrl+R", press({ control: true }), "linux")).toBe(true);
    expect(acceleratorMatches("CmdOrCtrl+R", press({ meta: true }), "darwin")).toBe(true);
    expect(acceleratorMatches("CmdOrCtrl+R", press({ control: true }), "darwin")).toBe(false);
    expect(
      acceleratorMatches("CmdOrCtrl+R", press({ control: true, shift: true, key: "R" }), "linux")
    ).toBe(false);
    expect(
      acceleratorMatches(
        "CmdOrCtrl+Shift+R",
        press({ control: true, shift: true, key: "R" }),
        "linux"
      )
    ).toBe(true);
    expect(acceleratorMatches("F5", press({ key: "F5" }), "linux")).toBe(true);
    expect(acceleratorMatches("Alt+Left", press({ key: "ArrowLeft", alt: true }), "linux")).toBe(
      true
    );
    expect(
      acceleratorMatches("CmdOrCtrl+R", { ...press({ control: true }), type: "keyUp" }, "linux")
    ).toBe(false);
  });

  it("finds the chords a client reserves, in nested submenus too", () => {
    expect(chromeOwnedItems(model)).toEqual([{ id: "reload", accelerator: "CmdOrCtrl+R" }]);
    expect(chromeOwnedItems(undefined)).toEqual([]);
    expect(
      chromeOwnedItems({
        menus: [
          {
            label: "A",
            items: [
              {
                label: "S",
                submenu: [{ id: "x", label: "X", accelerator: "F1", chromeOwned: true }],
              },
            ],
          },
        ],
      })
    ).toEqual([{ id: "x", accelerator: "F1" }]);
  });
});

describe("application menu template", () => {
  it("keeps only role menus of its own and puts the client's menus between them", () => {
    const template = buildApplicationMenuTemplate(model, {
      platform: "linux",
      appName: "Vibestudio",
      dispatch: vi.fn(),
    }) as Template;
    expect(template.map((entry) => entry.label)).toEqual(["Edit", "Panel", "Window"]);
    // The host knows no Bookmarks, History or Settings: only what the client sent.
    const labels = JSON.stringify(template);
    for (const hardCoded of ["Bookmarks", "History", "Settings", "Command", "Switch Workspace"]) {
      expect(labels).not.toContain(hardCoded);
    }
  });

  it("adds the application menu on macOS and relays a chosen item as its action id", () => {
    const dispatch = vi.fn();
    const template = buildApplicationMenuTemplate(model, {
      platform: "darwin",
      appName: "Vibestudio",
      dispatch,
    }) as Template;
    expect(template[0]!.label).toBe("Vibestudio");
    const panel = template.find((entry) => entry.label === "Panel")!;
    panel.submenu![0]!.click!();
    panel.submenu![2]!.submenu![0]!.click!();
    expect(dispatch.mock.calls).toEqual([["reload"], ["zoom-in"]]);
  });

  it("places a client's application-menu entries after About on macOS only", () => {
    const options = { appName: "Vibestudio", dispatch: vi.fn() };
    const mac = buildApplicationMenuTemplate(model, { ...options, platform: "darwin" }) as Template;
    expect(mac[0]!.submenu!.map((entry) => entry.label ?? entry.role)).toEqual([
      "about",
      undefined,
      "Settings…",
      undefined,
      "services",
      undefined,
      "hide",
      "hideOthers",
      "unhide",
      undefined,
      "quit",
    ]);
    mac[0]!.submenu![2]!.click!();
    expect(options.dispatch).toHaveBeenCalledWith("settings");
    const linux = buildApplicationMenuTemplate(model, {
      ...options,
      platform: "linux",
    }) as Template;
    expect(JSON.stringify(linux)).not.toContain("Settings…");
  });

  it("contributes nothing when no client contributed anything", () => {
    const template = buildApplicationMenuTemplate(undefined, {
      platform: "linux",
      appName: "Vibestudio",
      dispatch: vi.fn(),
    }) as Template;
    expect(template.map((entry) => entry.label)).toEqual(["Edit", "Window"]);
    expect(buildPopupTemplate(undefined, vi.fn())).toEqual([
      { label: "Exit", accelerator: "CmdOrCtrl+Q", role: "quit" },
    ]);
  });

  it("opens the client's popup followed by the host's Exit", () => {
    const dispatch = vi.fn();
    const template = buildPopupTemplate(model, dispatch) as Template;
    expect(template.map((entry) => entry.label)).toEqual(["Settings…", undefined, "Exit"]);
    template[0]!.click!();
    expect(dispatch).toHaveBeenCalledWith("settings");
  });
});

describe("ClientMenus", () => {
  beforeEach(() => {
    mocks.setApplicationMenu.mockClear();
    mocks.buildFromTemplate.mockClear();
  });

  it("shows the focused window's client menu and forgets a window that closed", () => {
    const deliver = vi.fn();
    const menus = new ClientMenus({ deliver, platform: "linux", appName: "V" });
    menus.set("w1", model);
    menus.applyFor("w1");
    const applied = mocks.buildFromTemplate.mock.calls.at(-1)![0] as Template;
    expect(applied.map((entry) => entry.label)).toContain("Panel");
    menus.applyFor("w2");
    expect(
      (mocks.buildFromTemplate.mock.calls.at(-1)![0] as Template).map((e) => e.label)
    ).not.toContain("Panel");
    menus.clear("w1");
    expect(menus.get("w1")).toBeUndefined();
  });

  it("intercepts a client's reserved chord before any page sees it, once per web contents", () => {
    const deliver = vi.fn();
    const menus = new ClientMenus({ deliver, platform: "linux", appName: "V" });
    menus.set("w1", model);
    const shortcuts = menus.shortcutsFor("w1");
    const handlers: Array<(event: { preventDefault(): void }, input: unknown) => void> = [];
    const contents = { on: vi.fn((_e: string, h: never) => handlers.push(h)) } as never;
    shortcuts.intercept(contents);
    shortcuts.intercept(contents);
    expect(handlers).toHaveLength(1);

    const preventDefault = vi.fn();
    handlers[0]!(
      { preventDefault },
      { type: "keyDown", key: "r", control: true, shift: false, alt: false, meta: false }
    );
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith("w1", "reload");
    handlers[0]!(
      { preventDefault },
      { type: "keyDown", key: "k", control: true, shift: false, alt: false, meta: false }
    );
    expect(deliver).toHaveBeenCalledTimes(1);
    const chord = { type: "keyDown", shift: false, alt: false, meta: false, control: true };
    expect(shortcuts.isChromeOwned({ ...chord, key: "r" } as never)).toBe(true);
    expect(shortcuts.isChromeOwned({ ...chord, key: "w" } as never)).toBe(false);
  });
});
