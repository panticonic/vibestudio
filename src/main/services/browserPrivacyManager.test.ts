import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const window = {
    webContents: {
      id: 41,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    },
    isDestroyed: vi.fn(() => false),
    loadFile: vi.fn(async () => {}),
    setContentProtection: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn(),
  };
  return {
    handlers,
    window,
    BrowserWindow: vi.fn(() => window),
    showSaveDialog: vi.fn(),
    handle: vi.fn((name: string, handler: (...args: any[]) => unknown) =>
      handlers.set(name, handler)
    ),
    removeHandler: vi.fn((name: string) => handlers.delete(name)),
  };
});
const files = vi.hoisted(() => ({
  writeFile: vi.fn(async () => {}),
  chmod: vi.fn(async () => {}),
}));

vi.mock("electron", () => ({
  BrowserWindow: electron.BrowserWindow,
  dialog: { showSaveDialog: electron.showSaveDialog },
  ipcMain: { handle: electron.handle, removeHandler: electron.removeHandler },
}));
vi.mock("node:fs/promises", () => files);

import { BrowserPrivacyManager, cookieExport, passwordExport } from "./browserPrivacyManager.js";
import { BrowserPrivacyRequestSchema } from "./browserPrivacyProtocol.js";

const password = {
  id: 1,
  origin_url: "https://example.com",
  username: "alice",
  password: "secret",
  action_url: "https://example.com/login",
  realm: "",
  date_created: null,
  date_last_used: null,
  date_password_changed: null,
  times_used: 1,
};
const cookie = {
  name: "session",
  value: "cookie-secret",
  domain: "example.com",
  path: "/",
  hostOnly: true,
  secure: true,
  httpOnly: true,
  sameSite: "lax" as const,
};

function vault() {
  return {
    listPasswordSummaries: vi.fn(async () => [{ ...password, password: undefined }]),
    getNeverSavePasswordOrigins: vi.fn(async () => ["https://never.example"]),
    listFormFillValues: vi.fn(async () => [
      {
        id: 2,
        fieldName: "email",
        type: "email",
        value: "a@example.com",
        displayLabel: null,
        aliases: [],
        createdAt: 1,
        updatedAt: 2,
        useCount: 3,
      },
    ]),
    listCookieOrigins: vi.fn(async () => ({ revision: 4, origins: ["https://example.com"] })),
    getPasswordForSite: vi.fn(async () => [password]),
    getCookiesForOrigin: vi.fn(async () => [cookie]),
    deletePassword: vi.fn(async () => {}),
    removeNeverSavePassword: vi.fn(async () => {}),
    addFormFillValue: vi.fn(async () => 3),
    updateFormFillValue: vi.fn(async () => {}),
    deleteFormFillValue: vi.fn(async () => {}),
    clearFormFillValues: vi.fn(async () => 1),
    clearCookiesForOrigin: vi.fn(async () => 1),
    endBrowserSession: vi.fn(async () => 1),
    clearAllCookies: vi.fn(async () => 1),
  };
}

describe("browser privacy manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electron.handlers.clear();
  });

  it("validates every typed IPC request", () => {
    expect(() =>
      BrowserPrivacyRequestSchema.parse({ action: "deletePassword", id: "1" })
    ).toThrow();
    expect(() => BrowserPrivacyRequestSchema.parse({ action: "unknown" })).toThrow();
    expect(() =>
      BrowserPrivacyRequestSchema.parse({
        action: "addFormFill",
        type: "not-a-form-type",
        value: "value",
      })
    ).toThrow();
    expect(() =>
      BrowserPrivacyRequestSchema.parse({
        action: "addFormFill",
        type: "email",
        value: "   ",
      })
    ).toThrow();
  });

  it("preserves the prior password and cookie export shapes", () => {
    expect(JSON.parse(passwordExport([password], "json"))).toEqual([
      {
        url: "https://example.com",
        username: "alice",
        password: "secret",
        actionUrl: "https://example.com/login",
      },
    ]);
    expect(passwordExport([password], "csv-chrome")).toContain("url,username,password,name");
    expect(passwordExport([password], "csv-firefox")).toContain("url,username,password");
    const cookieJson = JSON.parse(
      cookieExport([{ ...cookie, encryptedValue: "must-not-export", revision: 9 } as never], "json")
    )[0];
    expect(cookieJson).toMatchObject({
      name: "session",
      valueStatus: "available",
      value: "cookie-secret",
      sourceScheme: "unset",
      sourcePort: -1,
    });
    expect(cookieJson).not.toHaveProperty("encryptedValue");
    expect(cookieJson).not.toHaveProperty("revision");
    expect(cookieExport([cookie], "netscape-txt")).toContain("# Netscape HTTP Cookie File");
    expect(() =>
      cookieExport(
        [
          {
            ...cookie,
            partitionKey: { topLevelSite: "https://top.example", hasCrossSiteAncestor: false },
          },
        ],
        "netscape-txt"
      )
    ).toThrow();
  });

  it("binds the packaged renderer, rejects foreign senders, dispatches destructive actions, and tears down", async () => {
    const store = vault();
    const manager = new BrowserPrivacyManager({
      vault: store as never,
      getProjection: () =>
        ({
          diagnostics: () => ({
            revision: 4,
            hostId: "host",
            converged: true,
            mismatchCount: 0,
            outboxDepth: 0,
          }),
        }) as never,
      preloadPath: "/dist/browserPrivacyPreload.cjs",
      htmlPath: "/dist/browserPrivacy.html",
    });
    await manager.open("inspect");
    expect(electron.window.loadFile).toHaveBeenCalledWith("/dist/browserPrivacy.html", {
      query: { section: "inspect" },
    });
    expect(electron.window.setContentProtection).toHaveBeenCalledOnce();
    expect(electron.window.setContentProtection).toHaveBeenCalledWith(true);
    expect(electron.window.setContentProtection.mock.invocationCallOrder[0]).toBeLessThan(
      electron.window.loadFile.mock.invocationCallOrder[0]!
    );
    expect(electron.window.webContents.setWindowOpenHandler).toHaveBeenCalled();
    expect(electron.window.webContents.on).toHaveBeenCalledWith(
      "will-navigate",
      expect.any(Function)
    );
    const handler = electron.handlers.get("vibestudio:browser-privacy:call")!;
    await expect(
      handler({ sender: { id: 7 } }, { action: "snapshot", origin: "" })
    ).rejects.toMatchObject({ code: "EACCES" });
    const snapshot = (await handler(
      { sender: { id: 41 } },
      { action: "snapshot", origin: "https://example.com" }
    )) as any;
    expect(snapshot.value).toMatchObject({
      inspect: { origin: "https://example.com", passwordCount: 1, cookieCount: 1 },
      diagnostics: { revision: 4 },
    });
    for (const request of [
      { action: "deletePassword", id: 1 },
      { action: "removeNeverSave", origin: "https://never.example" },
      {
        action: "addFormFill",
        type: "email",
        value: "new@example.com",
        displayLabel: "Work email",
      },
      { action: "updateFormFill", id: 2, value: "b@example.com" },
      { action: "deleteFormFill", id: 2 },
      { action: "clearFormFill" },
      { action: "clearOrigin", origin: "https://example.com" },
      { action: "endSession" },
      { action: "clearAllCookies" },
    ] as const)
      await handler({ sender: { id: 41 } }, request);
    expect(store.deletePassword).toHaveBeenCalledWith(1);
    expect(store.removeNeverSavePassword).toHaveBeenCalled();
    expect(store.addFormFillValue).toHaveBeenCalledWith({
      fieldName: "email",
      type: "email",
      value: "new@example.com",
      displayLabel: "Work email",
    });
    expect(store.updateFormFillValue).toHaveBeenCalled();
    expect(store.deleteFormFillValue).toHaveBeenCalled();
    expect(store.clearFormFillValues).toHaveBeenCalled();
    expect(store.clearCookiesForOrigin).toHaveBeenCalled();
    expect(store.endBrowserSession).toHaveBeenCalled();
    expect(store.clearAllCookies).toHaveBeenCalled();
    manager.destroy();
    expect(electron.window.destroy).toHaveBeenCalledOnce();
    expect(electron.removeHandler).toHaveBeenCalledWith("vibestudio:browser-privacy:call");
  });

  it("does not show or focus when the packaged manager renderer fails to load", async () => {
    electron.window.loadFile.mockRejectedValueOnce(new Error("missing packaged asset"));
    const manager = new BrowserPrivacyManager({
      vault: vault() as never,
      getProjection: () => null,
      preloadPath: "/dist/browserPrivacyPreload.cjs",
      htmlPath: "/dist/missing-browserPrivacy.html",
    });
    await expect(manager.open("credentials")).rejects.toThrow(/missing packaged asset/i);
    expect(electron.window.show).not.toHaveBeenCalled();
    expect(electron.window.focus).not.toHaveBeenCalled();
  });

  it("cancels export without writing and writes selected exports mode 0600", async () => {
    const manager = new BrowserPrivacyManager({
      vault: vault() as never,
      getProjection: () => null,
      preloadPath: "/preload",
      htmlPath: "/html",
    });
    await manager.open("export");
    const handler = electron.handlers.get("vibestudio:browser-privacy:call")!;
    electron.showSaveDialog.mockResolvedValueOnce({ canceled: true });
    await handler({ sender: { id: 41 } }, { action: "exportPasswords", format: "json" });
    expect(files.writeFile).not.toHaveBeenCalled();
    electron.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: "/chosen/passwords.json",
    });
    await handler({ sender: { id: 41 } }, { action: "exportPasswords", format: "json" });
    expect(files.writeFile).toHaveBeenCalledWith("/chosen/passwords.json", expect.any(String), {
      mode: 0o600,
    });
    expect(files.chmod).toHaveBeenCalledWith("/chosen/passwords.json", 0o600);
    manager.destroy();
  });
});
