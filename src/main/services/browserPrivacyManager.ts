import { BrowserWindow, dialog, ipcMain } from "electron";
import { chmod, writeFile } from "node:fs/promises";
import type { BrowserCookieProjectionApi } from "./browserCookieProjection.js";
import type { BrowserVaultNativeClient } from "./browserVaultNativeClient.js";
import { BrowserPrivacyController, type BrowserPrivacyExport } from "./browserPrivacyController.js";
import {
  BrowserPrivacyRequestSchema,
  type BrowserPrivacyRequest,
  type BrowserPrivacyResult,
  type BrowserPrivacySection,
} from "./browserPrivacyProtocol.js";
export type { BrowserPrivacySection } from "./browserPrivacyProtocol.js";
export { cookieExport, passwordExport } from "./browserPrivacyController.js";

export class BrowserPrivacyManager {
  private window: BrowserWindow | null = null;
  private windowWebContentsId: number | null = null;
  readonly controller: BrowserPrivacyController;

  constructor(
    private readonly deps: {
      vault: BrowserVaultNativeClient;
      getProjection(): BrowserCookieProjectionApi | null;
      preloadPath: string;
      htmlPath: string;
    }
  ) {
    this.controller = new BrowserPrivacyController(deps);
    ipcMain.handle(
      "vibestudio:browser-privacy:call",
      async (event, raw: unknown): Promise<BrowserPrivacyResult> => {
        if (event.sender.id !== this.windowWebContentsId) {
          throw Object.assign(new Error("Untrusted browser privacy manager caller"), {
            code: "EACCES",
          });
        }
        try {
          return { ok: true, value: await this.call(BrowserPrivacyRequestSchema.parse(raw)) };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
    );
  }

  async open(section: BrowserPrivacySection = "credentials"): Promise<void> {
    const window = this.ensureWindow();
    await window.loadFile(this.deps.htmlPath, { query: { section } });
    window.show();
    window.focus();
  }

  destroy(): void {
    this.window?.destroy();
    this.window = null;
    this.windowWebContentsId = null;
    ipcMain.removeHandler("vibestudio:browser-privacy:call");
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    this.window = new BrowserWindow({
      title: "Browser privacy",
      width: 900,
      height: 680,
      show: false,
      webPreferences: {
        preload: this.deps.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    // This dedicated window renders decrypted form-fill values and protected
    // browser metadata. Keep it out of routine OS screenshots/screen sharing
    // for the entire lifetime of the native presentation; destroying the
    // BrowserWindow releases Electron's platform capture exclusion with it.
    this.window.setContentProtection(true);
    this.window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.window.webContents.on("will-navigate", (event) => event.preventDefault());
    this.windowWebContentsId = this.window.webContents.id;
    this.window.on("closed", () => {
      this.window = null;
      this.windowWebContentsId = null;
    });
    return this.window;
  }

  private async call(request: BrowserPrivacyRequest): Promise<unknown> {
    const result = await this.controller.execute(request);
    if (request.action !== "exportPasswords" && request.action !== "exportCookies") return result;
    return this.saveExport(
      result as BrowserPrivacyExport,
      request.action === "exportPasswords" ? "Export saved passwords" : "Export cookies"
    );
  }

  private async saveExport(artifact: BrowserPrivacyExport, title: string) {
    const extension = artifact.filename.split(".").at(-1) ?? "txt";
    const selected = await dialog.showSaveDialog({
      title,
      defaultPath: artifact.filename,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    });
    if (selected.canceled || !selected.filePath) return null;
    await writeFile(
      selected.filePath,
      Buffer.from(artifact.contentBase64, "base64").toString("utf8"),
      { mode: 0o600 }
    );
    // `mode` applies only when the file is created. A user may deliberately
    // replace an existing export, so normalize its final permissions too.
    await chmod(selected.filePath, 0o600);
    return { exported: artifact.count };
  }
}
