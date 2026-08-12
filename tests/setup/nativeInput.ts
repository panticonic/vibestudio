import type { ElectronApplication } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getPanelSelectorWindowPoint } from "./electronSetup.js";
import { E2E_OWNED_X11_ENV } from "./ownedXvfb.js";

const execFileAsync = promisify(execFile);

interface NativeWindowInfo {
  id: string;
  pid: number;
  contentOffset: { x: number; y: number };
}

async function nativeWindowInfo(app: ElectronApplication): Promise<NativeWindowInfo> {
  return app.evaluate(({ BaseWindow, BrowserWindow }) => {
    const win = BaseWindow.getAllWindows()[0] ?? BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("No Electron window");
    const handle = win.getNativeWindowHandle();
    const bounds = win.getBounds();
    const contentBounds = win.getContentBounds();
    return {
      id: process.platform === "linux" ? String(handle.readUInt32LE(0)) : handle.toString("hex"),
      pid: process.pid,
      contentOffset: {
        x: contentBounds.x - bounds.x,
        y: contentBounds.y - bounds.y,
      },
    };
  });
}

function requireOwnedLinuxInput(): void {
  if (process.platform !== "linux") {
    throw new Error("The native-input backend currently supports Linux/X11 only");
  }
  if (process.env[E2E_OWNED_X11_ENV] !== "1" || !process.env.DISPLAY) {
    throw new Error("Linux native-input coverage requires the Playwright-owned Xvfb display");
  }
}

async function validatedWindowId(app: ElectronApplication): Promise<NativeWindowInfo> {
  requireOwnedLinuxInput();
  const windowInfo = await nativeWindowInfo(app);
  const { stdout } = await execFileAsync("xdotool", ["getwindowpid", windowInfo.id]);
  const actualPid = Number(stdout.trim());
  if (actualPid !== windowInfo.pid) {
    throw new Error(
      `Native Electron window ${windowInfo.id} belongs to pid ${actualPid}, expected ${windowInfo.pid}`
    );
  }
  return windowInfo;
}

async function focusTerminalThroughNativeInput(
  app: ElectronApplication,
  panelId: string
): Promise<NativeWindowInfo> {
  const point =
    (await getPanelSelectorWindowPoint(app, panelId, ".xterm-helper-textarea")) ??
    (await getPanelSelectorWindowPoint(app, panelId, ".xterm"));
  if (!point) throw new Error("Terminal input surface does not have a native-window point");
  const windowInfo = await validatedWindowId(app);
  await execFileAsync("xdotool", ["windowfocus", "--sync", windowInfo.id]);
  const { stdout } = await execFileAsync("xdotool", ["getwindowfocus"]);
  if (stdout.trim() !== windowInfo.id) {
    throw new Error(`Native focus did not converge on Electron window ${windowInfo.id}`);
  }
  await execFileAsync("xdotool", [
    "mousemove",
    "--window",
    windowInfo.id,
    String(windowInfo.contentOffset.x + point.x),
    String(windowInfo.contentOffset.y + point.y),
    "click",
    "1",
  ]);
  return windowInfo;
}

export async function typeTerminalThroughNativeInput(
  app: ElectronApplication,
  panelId: string,
  command: string
): Promise<void> {
  const windowInfo = await focusTerminalThroughNativeInput(app, panelId);
  await execFileAsync("xdotool", ["key", "--window", windowInfo.id, "ctrl+u"]);
  await execFileAsync("xdotool", ["type", "--window", windowInfo.id, "--delay", "1", command]);
  await execFileAsync("xdotool", ["key", "--window", windowInfo.id, "Return"]);
}

export async function pressTerminalShortcutThroughNativeInput(
  app: ElectronApplication,
  panelId: string,
  key: string
): Promise<void> {
  const windowInfo = await focusTerminalThroughNativeInput(app, panelId);
  await execFileAsync("xdotool", [
    "key",
    "--window",
    windowInfo.id,
    `control+shift+${key.toLowerCase()}`,
  ]);
}
