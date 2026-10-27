import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  type Listener = (...args: any[]) => unknown;
  const handlers = new Map<string, Listener>();
  const listeners = new Map<string, Listener>();
  const views: ReturnType<typeof makeView>[] = [];
  const loads: Promise<void>[] = [];
  let nextId = 40;
  function makeView() {
    let visible = false;
    let destroyed = false;
    const events = new Map<string, Listener>();
    return {
      events,
      setBounds: vi.fn(),
      setVisible: vi.fn((value: boolean) => {
        visible = value;
      }),
      getVisible: vi.fn(() => visible),
      webContents: {
        id: ++nextId,
        loadFile: vi.fn(() => loads.shift() ?? Promise.resolve()),
        setWindowOpenHandler: vi.fn(),
        on: vi.fn((name: string, callback: Listener) => events.set(name, callback)),
        send: vi.fn(),
        focus: vi.fn(),
        close: vi.fn(() => {
          destroyed = true;
        }),
        isDestroyed: vi.fn(() => destroyed),
      },
    };
  }
  function makeWindow(initialProtection = false) {
    let protectedContent = initialProtection;
    let destroyed = false;
    const events = new Map<string, Listener>();
    return {
      events,
      markDestroyed: () => {
        destroyed = true;
      },
      isDestroyed: vi.fn(() => destroyed),
      isContentProtected: vi.fn(() => protectedContent),
      setContentProtection: vi.fn((value: boolean) => {
        protectedContent = value;
      }),
      on: vi.fn((name: string, callback: Listener) => events.set(name, callback)),
      off: vi.fn((name: string) => events.delete(name)),
      contentView: { removeChildView: vi.fn() },
    };
  }
  return {
    handlers,
    listeners,
    views,
    loads,
    makeWindow,
    BrowserWindow: vi.fn(() => {
      throw new Error("Browser data must not open another window");
    }),
    WebContentsView: vi.fn(function () {
      const view = makeView();
      views.push(view);
      return view;
    }),
    showSaveDialog: vi.fn(),
    handle: vi.fn((name: string, callback: Listener) => handlers.set(name, callback)),
    on: vi.fn((name: string, callback: Listener) => listeners.set(name, callback)),
    removeHandler: vi.fn((name: string) => handlers.delete(name)),
    removeListener: vi.fn((name: string) => listeners.delete(name)),
  };
});
const files = vi.hoisted(() => ({
  writeFile: vi.fn(async () => {}),
  chmod: vi.fn(async () => {}),
}));
vi.mock("electron", () => ({
  BrowserWindow: electron.BrowserWindow,
  WebContentsView: electron.WebContentsView,
  nativeTheme: { shouldUseDarkColors: true },
  dialog: { showSaveDialog: electron.showSaveDialog },
  ipcMain: {
    handle: electron.handle,
    on: electron.on,
    removeHandler: electron.removeHandler,
    removeListener: electron.removeListener,
  },
}));
vi.mock("node:fs/promises", () => files);

import { BrowserDataView } from "./browserDataView.js";
import { cookieExport, passwordExport } from "./browserPrivacyController.js";
import { BrowserPrivacyRequestSchema } from "./browserPrivacyProtocol.js";
import { BrowserPrivacySnapshotSchema } from "@vibestudio/service-schemas/browserPrivacy";

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
const created: BrowserDataView[] = [];
function createOwner(overrides: Partial<ConstructorParameters<typeof BrowserDataView>[0]> = {}) {
  const window = electron.makeWindow();
  const store = vault();
  const onClose = vi.fn();
  const onFocusBoundary = vi.fn();
  const view = new BrowserDataView({
    vault: store as never,
    getDiagnostics: () => null,
    getWindow: () => window as never,
    workspaceName: "Personal",
    onClose,
    onFocusBoundary,
    preloadPath: "/dist/browserDataPreload.cjs",
    htmlPath: "/dist/browserData.html",
    ...overrides,
  });
  created.push(view);
  return { view, window, store, onClose, onFocusBoundary };
}
const bounds = { x: 20, y: 140, width: 700, height: 450 };
const sender = (id: number) => ({ sender: { id } });
const invoke = (id: number, request: unknown) =>
  Promise.resolve(electron.handlers.get("vibestudio:browser-data:call")!(sender(id), request));
const emit = (name: string, id: number, payload?: unknown) =>
  electron.listeners.get(`vibestudio:browser-data:${name}`)?.(sender(id), payload);

beforeEach(() => {
  vi.clearAllMocks();
  electron.views.length = 0;
  electron.loads.length = 0;
});
afterEach(async () => {
  await Promise.all(created.splice(0).map((owner) => owner.destroy()));
});

describe("protected Browser data settings", () => {
  it("keeps synchronization diagnostics available when saved records cannot be read", async () => {
    const diagnostics = {
      revision: 0,
      hostId: "host",
      converged: false,
      mismatchCount: 0,
      outboxDepth: 0,
      lastError: "Browser environment unavailable",
    };
    const { view, store } = createOwner({ getDiagnostics: () => diagnostics });
    store.listPasswordSummaries.mockRejectedValueOnce(new Error("Vault is not ready"));
    await view.present({ dark: false, section: "siteData", bounds });
    const sender = { id: electron.views[0]!.webContents.id };
    const call = electron.handlers.get("vibestudio:browser-data:call")!;
    await expect(call({ sender }, { action: "snapshot" })).resolves.toMatchObject({
      ok: false,
      error: "Vault is not ready",
    });
    await expect(call({ sender }, { action: "diagnostics" })).resolves.toEqual({
      ok: true,
      value: diagnostics,
    });
  });
  it("validates typed requests and preserves standard export formats", () => {
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
      BrowserPrivacyRequestSchema.parse({ action: "addFormFill", type: "email", value: "   " })
    ).toThrow();
    expect(JSON.parse(passwordExport([password], "json"))).toEqual([
      {
        url: password.origin_url,
        username: "alice",
        password: "secret",
        actionUrl: password.action_url,
      },
    ]);
    expect(passwordExport([password], "csv-chrome")).toContain("url,username,password,name");
    expect(passwordExport([password], "csv-firefox")).toContain("url,username,password");
    const exported = JSON.parse(
      cookieExport([{ ...cookie, encryptedValue: "must-not-export", revision: 9 } as never], "json")
    )[0];
    expect(exported).toMatchObject({
      name: "session",
      valueStatus: "available",
      value: "cookie-secret",
      sourceScheme: "unset",
      sourcePort: -1,
    });
    expect(exported).not.toHaveProperty("encryptedValue");
    expect(exported).not.toHaveProperty("revision");
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

  it("uses protected native content inside the existing window and dispatches only its sender", async () => {
    const lastFailure = {
      message: "Cookie reconciliation failed: Vault unavailable",
      occurredAt: "2026-10-27T11:00:00.000Z",
      recoveredAt: "2026-10-27T11:00:01.000Z",
    };
    const applyCookies = vi.fn(async () => ({ revision: 4 }));
    const { view, window, store } = createOwner({
      applyCookies,
      getDiagnostics: () => ({
        revision: 4,
        hostId: "host",
        converged: true,
        mismatchCount: 0,
        outboxDepth: 0,
        lastFailure,
      }),
    });
    await view.present({ dark: false, section: "siteData", bounds, focus: "first" });
    const native = electron.views[0]!;
    const id = native.webContents.id;
    expect(electron.BrowserWindow).not.toHaveBeenCalled();
    expect(electron.WebContentsView).toHaveBeenCalledWith({
      webPreferences: {
        preload: "/dist/browserDataPreload.cjs",
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    expect(native.webContents.loadFile).toHaveBeenCalledExactlyOnceWith("/dist/browserData.html");
    expect(native.setBounds).toHaveBeenCalledWith(bounds);
    expect(view.getVisibleView()).toBe(native);
    expect(window.setContentProtection).toHaveBeenCalledWith(true);
    expect(window.setContentProtection.mock.invocationCallOrder[0]).toBeLessThan(
      native.webContents.loadFile.mock.invocationCallOrder[0]!
    );
    expect(native.webContents.focus).not.toHaveBeenCalled();
    expect(native.webContents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: "deny" });
    const preventDefault = vi.fn();
    native.events.get("will-navigate")!({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    await expect(invoke(7, { action: "snapshot" })).rejects.toMatchObject({
      code: "EACCES",
    });
    const snapshot = (await invoke(id, { action: "snapshot" })) as {
      ok: true;
      value: unknown;
    };
    expect(snapshot).toMatchObject({
      ok: true,
      value: {
        cookieOrigins: { revision: 4, origins: ["https://example.com"] },
      },
    });
    expect(BrowserPrivacySnapshotSchema.parse(snapshot.value).passwords).toHaveLength(1);
    expect(await invoke(id, { action: "diagnostics" })).toMatchObject({
      ok: true,
      value: { revision: 4, lastFailure },
    });
    await invoke(id, { action: "applyCookies" });
    expect(applyCookies).toHaveBeenCalledWith(expect.any(AbortSignal));
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
      { action: "clearAllCookies" },
    ])
      expect(await invoke(id, request)).toMatchObject({ ok: true });
    expect(store.deletePassword).toHaveBeenCalledWith(1);
    expect(store.addFormFillValue).toHaveBeenCalledWith({
      fieldName: "email",
      type: "email",
      value: "new@example.com",
      displayLabel: "Work email",
    });
    expect(store.updateFormFillValue).toHaveBeenCalledWith(2, { value: "b@example.com" });
    expect(store.clearCookiesForOrigin).toHaveBeenCalledWith("https://example.com");
    expect(store.clearAllCookies).toHaveBeenCalledOnce();
    expect(await invoke(id, { action: "deletePassword", id: "1" })).toMatchObject({ ok: false });
  });

  it("keeps active owners isolated and removes shared IPC only after the last owner is destroyed", async () => {
    const first = createOwner();
    const second = createOwner({ workspaceName: "Another workspace" });
    second.store.listPasswordSummaries.mockResolvedValueOnce([
      { ...password, username: "bob", password: undefined },
    ]);
    await Promise.all([
      first.view.present({ dark: false, section: "passwords", bounds }),
      second.view.present({ dark: false, section: "passwords", bounds }),
    ]);
    const secondNative = electron.views[1]!;
    const result = await invoke(secondNative.webContents.id, { action: "snapshot" });
    expect(result).toMatchObject({ ok: true, value: { passwords: [{ username: "bob" }] } });
    expect(first.store.listPasswordSummaries).not.toHaveBeenCalled();
    await first.view.destroy();
    expect(electron.removeHandler).not.toHaveBeenCalled();
    expect(await invoke(secondNative.webContents.id, { action: "snapshot" })).toMatchObject({
      ok: true,
    });
    await second.view.destroy();
    expect(electron.removeHandler).toHaveBeenCalledWith("vibestudio:browser-data:call");
    expect(electron.removeListener).toHaveBeenCalledWith(
      "vibestudio:browser-data:ready",
      expect.any(Function)
    );
  });

  it("replays presentation on readiness, ignores foreign controls, and denies stale controls after close", async () => {
    const { view, window, onClose, onFocusBoundary } = createOwner();
    await view.present({ dark: false, section: "autofill", bounds });
    const native = electron.views[0]!;
    const id = native.webContents.id;
    native.webContents.send.mockClear();
    emit("ready", 7);
    emit("close", 7);
    emit("focus", 7, { backward: true });
    expect(native.webContents.send).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onFocusBoundary).not.toHaveBeenCalled();
    emit("ready", id);
    expect(native.webContents.send).toHaveBeenCalledWith("vibestudio:browser-data:present", {
      section: "autofill",
      workspaceName: "Personal",
      dark: false,
    });
    emit("focus", id, { backward: "yes" });
    expect(onFocusBoundary).not.toHaveBeenCalled();
    emit("focus", id, { backward: true });
    expect(onFocusBoundary).toHaveBeenCalledExactlyOnceWith(true);
    emit("close", id);
    expect(onClose).toHaveBeenCalledOnce();
    view.close();
    expect(view.getVisibleView()).toBeNull();
    expect(view.owns(id)).toBe(false);
    expect(native.webContents.close).toHaveBeenCalledOnce();
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(native);
    expect(window.setContentProtection).toHaveBeenLastCalledWith(false);
    expect(native.webContents.close.mock.invocationCallOrder[0]).toBeLessThan(
      window.setContentProtection.mock.invocationCallOrder.at(-1)!
    );
    await expect(invoke(id, { action: "snapshot" })).rejects.toMatchObject({
      code: "EACCES",
    });
    emit("close", id);
    emit("focus", id, { backward: false });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onFocusBoundary).toHaveBeenCalledOnce();
  });

  it("restores pre-existing protection and retires native content on a renderer crash", async () => {
    const protectedWindow = electron.makeWindow(true);
    const { view, onClose } = createOwner({ getWindow: () => protectedWindow as never });
    await view.present({ dark: false, section: "siteData", bounds });
    const native = electron.views[0]!;
    native.events.get("render-process-gone")!();
    expect(view.getVisibleView()).toBeNull();
    expect(native.webContents.close).toHaveBeenCalledOnce();
    expect(protectedWindow.setContentProtection).toHaveBeenLastCalledWith(true);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("cleans up a load failure without showing or focusing the view", async () => {
    electron.loads.push(Promise.reject(new Error("missing packaged asset")));
    const { view, window } = createOwner();
    await expect(
      view.present({ dark: false, section: "passwords", bounds, focus: "first" })
    ).rejects.toThrow("missing packaged asset");
    const native = electron.views[0]!;
    expect(view.getVisibleView()).toBeNull();
    expect(native.setVisible).not.toHaveBeenCalledWith(true);
    expect(native.webContents.focus).not.toHaveBeenCalled();
    expect(native.webContents.close).toHaveBeenCalledOnce();
    expect(window.setContentProtection).toHaveBeenLastCalledWith(false);
  });

  it("does not resurrect a view closed while its packaged document was loading", async () => {
    let loaded!: () => void;
    electron.loads.push(
      new Promise<void>((resolve) => {
        loaded = resolve;
      })
    );
    const { view, window } = createOwner();
    const opening = view.present({ dark: false, section: "siteData", bounds, focus: "first" });
    const native = electron.views[0]!;
    view.close();
    loaded();
    await opening;
    expect(view.getVisibleView()).toBeNull();
    expect(native.setVisible).not.toHaveBeenCalledWith(true);
    expect(native.webContents.focus).not.toHaveBeenCalled();
    expect(window.setContentProtection).toHaveBeenLastCalledWith(false);
  });

  it("cancels and joins cookie application when its owning settings surface is destroyed", async () => {
    let signal!: AbortSignal;
    const applyCookies = vi.fn((next: AbortSignal) => {
      signal = next;
      return new Promise<{ revision: number }>((_resolve, reject) =>
        next.addEventListener("abort", () => reject(next.reason), { once: true })
      );
    });
    const { view } = createOwner({ applyCookies });
    await view.present({ dark: false, section: "siteData", bounds });
    const pending = invoke(electron.views[0]!.webContents.id, { action: "applyCookies" });
    expect(signal.aborted).toBe(false);
    await view.destroy();
    expect(signal.aborted).toBe(true);
    expect(await pending).toMatchObject({ ok: false, error: "Browser data settings closed" });
  });

  it("parents export dialogs to the app and preserves private file permissions", async () => {
    const { view, window } = createOwner();
    await view.present({ dark: false, section: "passwords", bounds });
    const id = electron.views[0]!.webContents.id;
    electron.showSaveDialog.mockResolvedValueOnce({ canceled: true });
    expect(await invoke(id, { action: "exportPasswords", format: "json" })).toEqual({
      ok: true,
      value: null,
    });
    expect(files.writeFile).not.toHaveBeenCalled();
    electron.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: "/chosen/passwords.json",
    });
    expect(await invoke(id, { action: "exportPasswords", format: "json" })).toEqual({
      ok: true,
      value: { exported: 1 },
    });
    expect(electron.showSaveDialog).toHaveBeenLastCalledWith(
      window,
      expect.objectContaining({
        title: "Export saved passwords",
        defaultPath: "vibestudio-passwords.json",
      })
    );
    expect(files.writeFile).toHaveBeenCalledWith("/chosen/passwords.json", expect.any(String), {
      mode: 0o600,
    });
    expect(files.chmod).toHaveBeenCalledWith("/chosen/passwords.json", 0o600);
  });
});
