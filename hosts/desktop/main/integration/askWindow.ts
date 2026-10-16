import { BrowserWindow, ipcMain, nativeTheme, type IpcMainEvent } from "electron";
import type { AskPort } from "./clientIntegration.js";

type Ask = Parameters<AskPort["open"]>[0];

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

/**
 * The compact ask window's page: one input, and the text result under it. It
 * shows results as text only. The host runs the intent; this page never reaches
 * a session.
 */
export function renderAskPage(title: string, dark: boolean): string {
  const [background, foreground, muted] = dark
    ? ["#111419", "#e6eaf0", "#9aa5b8"]
    : ["#edf1f6", "#1b2330", "#566176"];
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>
  html,body{margin:0;height:100%;background:${background};color:${foreground};font:14px system-ui,sans-serif}
  body{display:flex;flex-direction:column;padding:12px;box-sizing:border-box;gap:8px}
  label{color:${muted};font-size:12px}
  input{font:inherit;padding:8px;border:1px solid ${muted};border-radius:6px;background:transparent;color:inherit}
  pre{margin:0;white-space:pre-wrap;overflow:auto;flex:1;font:inherit}
</style></head>
<body>
<label for="q">${escapeHtml(title)}</label>
<input id="q" autofocus autocomplete="off">
<pre id="out" role="status"></pre>
<script>
  const input = document.getElementById("q");
  const out = document.getElementById("out");
  input.addEventListener("keydown", async (event) => {
    if (event.key === "Escape") return window.__vibestudioAsk.close();
    if (event.key !== "Enter" || !input.value.trim()) return;
    input.disabled = true;
    out.textContent = "...";
    try { out.textContent = await window.__vibestudioAsk.submit(input.value); }
    catch (error) { out.textContent = error instanceof Error ? error.message : String(error); }
    input.disabled = false;
    input.select();
    input.focus();
  });
</script></body></html>`;
}

/**
 * Compact ask windows (docs/client-hosts-and-clients-plan.md §7.2): the host's
 * own mini-prompt for a background intent run from a client's global shortcut.
 * One per client; asking again brings the open one forward.
 */
export class AskWindows implements AskPort {
  private readonly asks = new Map<number, { ask: Ask; window: BrowserWindow }>();
  private readonly byClient = new Map<string, BrowserWindow>();

  constructor(private readonly preloadPath: string) {
    ipcMain.handle("vibestudio:ask:submit", (event, text: unknown) => {
      const entry = this.asks.get(event.sender.id);
      if (!entry) throw new Error("Only an ask window can submit");
      if (typeof text !== "string") throw new Error("An ask takes text");
      return entry.ask.submit(text);
    });
    ipcMain.on("vibestudio:ask:close", (event: IpcMainEvent) => {
      this.asks.get(event.sender.id)?.window.close();
    });
  }

  open(ask: Ask): void {
    const existing = this.byClient.get(ask.clientId);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return;
    }
    const window = new BrowserWindow({
      width: 560,
      height: 220,
      show: false,
      title: ask.title,
      alwaysOnTop: true,
      skipTaskbar: true,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        preload: this.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    const id = window.webContents.id;
    this.asks.set(id, { ask, window });
    this.byClient.set(ask.clientId, window);
    window.once("ready-to-show", () => {
      window.show();
      window.focus();
    });
    window.on("closed", () => {
      this.asks.delete(id);
      if (this.byClient.get(ask.clientId) === window) this.byClient.delete(ask.clientId);
    });
    const page = renderAskPage(ask.title, nativeTheme.shouldUseDarkColors);
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  }
}
