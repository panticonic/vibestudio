import type { TestApp } from "./electronSetup";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getPanelSelectorWindowPoint } from "./electronSetup.js";
import { hasOwnedX11Display } from "./ownedXvfb.js";

const execFileAsync = promisify(execFile);

interface NativeWindowInfo {
  id: string;
  pid: number;
  contentOffset: { x: number; y: number };
}

async function nativeWindowInfo(owner: TestApp): Promise<NativeWindowInfo> {
  const { app } = owner;
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
  if (!hasOwnedX11Display()) {
    throw new Error("Native-input coverage requires the Playwright-owned Linux/X11 display");
  }
}

async function validatedWindowId(owner: TestApp): Promise<NativeWindowInfo> {
  requireOwnedLinuxInput();
  const windowInfo = await nativeWindowInfo(owner);
  const { stdout } = await execFileAsync("xdotool", ["getwindowpid", windowInfo.id]);
  const actualPid = Number(stdout.trim());
  if (actualPid !== windowInfo.pid) {
    throw new Error(
      `Native Electron window ${windowInfo.id} belongs to pid ${actualPid}, expected ${windowInfo.pid}`
    );
  }
  return windowInfo;
}

async function focusNativeWindow(owner: TestApp): Promise<NativeWindowInfo> {
  const windowInfo = await validatedWindowId(owner);
  await execFileAsync("xdotool", ["windowfocus", "--sync", windowInfo.id]);
  const { stdout } = await execFileAsync("xdotool", ["getwindowfocus"]);
  if (stdout.trim() !== windowInfo.id) {
    throw new Error(`Native focus did not converge on Electron window ${windowInfo.id}`);
  }
  return windowInfo;
}

export async function clickWindowPointThroughNativeInput(
  owner: TestApp,
  point: { x: number; y: number }
): Promise<void> {
  const windowInfo = await focusNativeWindow(owner);
  await execFileAsync("xdotool", [
    "mousemove",
    "--window",
    windowInfo.id,
    String(windowInfo.contentOffset.x + point.x),
    String(windowInfo.contentOffset.y + point.y),
    "click",
    "1",
  ]);
}

async function focusTerminalThroughNativeInput(
  owner: TestApp,
  panelId: string
): Promise<NativeWindowInfo> {
  const point =
    (await getPanelSelectorWindowPoint(owner, panelId, ".xterm-helper-textarea")) ??
    (await getPanelSelectorWindowPoint(owner, panelId, ".xterm"));
  if (!point) throw new Error("Terminal input surface does not have a native-window point");
  const windowInfo = await focusNativeWindow(owner);
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
  owner: TestApp,
  panelId: string,
  command: string
): Promise<void> {
  const windowInfo = await focusTerminalThroughNativeInput(owner, panelId);
  await execFileAsync("xdotool", ["key", "--window", windowInfo.id, "ctrl+u"]);
  await execFileAsync("xdotool", ["type", "--window", windowInfo.id, "--delay", "1", command]);
  await execFileAsync("xdotool", ["key", "--window", windowInfo.id, "Return"]);
}

export async function pressTerminalShortcutThroughNativeInput(
  owner: TestApp,
  panelId: string,
  key: string
): Promise<void> {
  const windowInfo = await focusTerminalThroughNativeInput(owner, panelId);
  await execFileAsync("xdotool", [
    "key",
    "--window",
    windowInfo.id,
    `control+shift+${key.toLowerCase()}`,
  ]);
}
