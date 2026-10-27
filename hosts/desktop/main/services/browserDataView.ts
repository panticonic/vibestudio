import { WebContentsView, dialog, ipcMain, type BaseWindow } from "electron";
import { chmod, writeFile } from "node:fs/promises";
import type { BrowserCookieProjectionDiagnostics } from "./browserCookieProjection.js";
import type { BrowserVaultNativeClient } from "./browserVaultNativeClient.js";
import { BrowserPrivacyController, type BrowserPrivacyExport } from "./browserPrivacyController.js";
import {
  BrowserPrivacyRequestSchema,
  type BrowserPrivacyResult,
  type BrowserPrivacySection,
} from "./browserPrivacyProtocol.js";

interface Presentation {
  dark: boolean;
  section: BrowserPrivacySection;
  bounds: { x: number; y: number; width: number; height: number };
  focus?: "first" | "last";
}

// Dispatch only by the native sender. Workspace-supplied ids never select data.
const owners = new Set<BrowserDataView>();
const owner = (senderId: number) => [...owners].find((entry) => entry.owns(senderId));
const ready = (event: Electron.IpcMainEvent) => owner(event.sender.id)?.publishPresentation();
const close = (event: Electron.IpcMainEvent) => owner(event.sender.id)?.requestClose();
const focus = (event: Electron.IpcMainEvent, payload: unknown) => {
  if (
    payload &&
    typeof payload === "object" &&
    "backward" in payload &&
    typeof payload.backward === "boolean"
  )
    owner(event.sender.id)?.requestFocus(payload.backward);
};

/** Protected settings content. ViewManager owns its native attachment and stack. */
export class BrowserDataView {
  private view: WebContentsView | null = null;
  private loading: Promise<void> | null = null;
  private presentation: Presentation | null = null;
  private window: BaseWindow | null = null;
  private previousContentProtection = false;
  private lifetime: AbortController | null = null;
  private readonly operations = new Set<Promise<BrowserPrivacyResult>>();
  private readonly controller: BrowserPrivacyController;
  private readonly handleWindowClosed = () => this.close();

  constructor(
    private readonly deps: {
      vault: BrowserVaultNativeClient;
      getDiagnostics(): BrowserCookieProjectionDiagnostics | null;
      applyCookies?: (signal: AbortSignal) => Promise<{ revision: number }>;
      getWindow(): BaseWindow | null;
      workspaceName: string;
      onClose(): void;
      onFocusBoundary(backward: boolean): void;
      preloadPath: string;
      htmlPath: string;
    }
  ) {
    this.controller = new BrowserPrivacyController(deps);
    if (!owners.size) {
      ipcMain.handle("vibestudio:browser-data:call", async (event, raw: unknown) => {
        const view = owner(event.sender.id);
        if (!view)
          throw Object.assign(new Error("Untrusted Browser data caller"), { code: "EACCES" });
        return view.execute(raw);
      });
      ipcMain.on("vibestudio:browser-data:ready", ready);
      ipcMain.on("vibestudio:browser-data:close", close);
      ipcMain.on("vibestudio:browser-data:focus", focus);
    }
    owners.add(this);
  }

  async present(options: Presentation): Promise<void> {
    const view = this.ensureView();
    this.presentation = options;
    view.setBounds(options.bounds);
    await this.loading;
    if (this.view !== view || view.webContents.isDestroyed()) return;
    view.setVisible(true);
    this.publishPresentation();
  }

  getVisibleView(): WebContentsView | null {
    return this.view && !this.view.webContents.isDestroyed() && this.view.getVisible()
      ? this.view
      : null;
  }

  owns(senderId: number): boolean {
    return this.view?.webContents.id === senderId && !this.view.webContents.isDestroyed();
  }

  publishPresentation(): void {
    if (!this.view || !this.presentation || this.view.webContents.isDestroyed()) return;
    this.view.webContents.send("vibestudio:browser-data:present", {
      section: this.presentation.section,
      workspaceName: this.deps.workspaceName,
      dark: this.presentation.dark,
      ...(this.presentation.focus ? { focus: this.presentation.focus } : {}),
    });
  }

  notifyChanged(): void {
    if (this.view && !this.view.webContents.isDestroyed())
      this.view.webContents.send("vibestudio:browser-data:changed");
  }
  requestClose(): void {
    this.deps.onClose();
  }
  requestFocus(backward: boolean): void {
    this.deps.onFocusBoundary(backward);
  }

  close(): void {
    const view = this.view;
    this.view = null;
    this.presentation = null;
    this.loading = null;
    this.lifetime?.abort(new DOMException("Browser data settings closed", "AbortError"));
    this.lifetime = null;
    const window = this.window;
    this.window = null;
    if (window && !window.isDestroyed()) {
      window.off("closed", this.handleWindowClosed);
      if (view) window.contentView.removeChildView(view);
    }
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
    if (window && !window.isDestroyed())
      window.setContentProtection(this.previousContentProtection);
  }

  async destroy(): Promise<void> {
    this.close();
    owners.delete(this);
    if (!owners.size) {
      ipcMain.removeHandler("vibestudio:browser-data:call");
      ipcMain.removeListener("vibestudio:browser-data:ready", ready);
      ipcMain.removeListener("vibestudio:browser-data:close", close);
      ipcMain.removeListener("vibestudio:browser-data:focus", focus);
    }
    await Promise.allSettled([...this.operations]);
  }

  execute(raw: unknown): Promise<BrowserPrivacyResult> {
    const signal = this.lifetime?.signal;
    if (!signal) return Promise.resolve({ ok: false, error: "Browser data settings are closed" });
    const task = (async (): Promise<BrowserPrivacyResult> => {
      try {
        signal.throwIfAborted();
        const request = BrowserPrivacyRequestSchema.parse(raw);
        const result = await this.controller.execute(request, signal);
        signal.throwIfAborted();
        const value =
          request.action === "exportPasswords" || request.action === "exportCookies"
            ? await this.saveExport(result as BrowserPrivacyExport, request.action, signal)
            : result;
        signal.throwIfAborted();
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    })();
    this.operations.add(task);
    void task.finally(() => this.operations.delete(task));
    return task;
  }

  private ensureView(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    const window = this.deps.getWindow();
    if (!window || window.isDestroyed())
      throw new Error("Browser data settings window is unavailable");
    this.window = window;
    this.previousContentProtection = window.isContentProtected();
    window.setContentProtection(true);
    window.on("closed", this.handleWindowClosed);
    this.lifetime = new AbortController();
    const view = new WebContentsView({
      webPreferences: {
        preload: this.deps.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    this.view = view;
    view.setVisible(false);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("will-navigate", (event) => event.preventDefault());
    view.webContents.on("render-process-gone", () => {
      if (this.view !== view) return;
      this.close();
      this.deps.onClose();
    });
    this.loading = view.webContents.loadFile(this.deps.htmlPath).catch((error: unknown) => {
      if (this.view === view) this.close();
      throw error;
    });
    return view;
  }

  private async saveExport(
    artifact: BrowserPrivacyExport,
    action: "exportPasswords" | "exportCookies",
    signal: AbortSignal
  ) {
    const window = this.window;
    if (!window || window.isDestroyed()) throw new Error("Browser data settings are closed");
    const extension = artifact.filename.split(".").at(-1) ?? "txt";
    const selected = await dialog.showSaveDialog(window, {
      title: action === "exportPasswords" ? "Export saved passwords" : "Export cookies",
      defaultPath: artifact.filename,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    });
    signal.throwIfAborted();
    if (selected.canceled || !selected.filePath) return null;
    await writeFile(
      selected.filePath,
      Buffer.from(artifact.contentBase64, "base64").toString("utf8"),
      { mode: 0o600 }
    );
    await chmod(selected.filePath, 0o600);
    return { exported: artifact.count };
  }
}
