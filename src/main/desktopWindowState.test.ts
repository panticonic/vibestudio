import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BaseWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopWindowState, fitWindowBounds } from "./desktopWindowState.js";

const roots: string[] = [];
function stateFile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-window-state-"));
  roots.push(root);
  return path.join(root, "window.json");
}
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const area = { x: 0, y: 0, width: 1920, height: 1080 };

describe("desktop window restoration", () => {
  it("centers the larger default and fits small displays", () => {
    const state = new DesktopWindowState(stateFile());
    expect(state.initialBounds(() => area)).toEqual({ x: 240, y: 90, width: 1440, height: 900 });
    expect(state.initialBounds(() => ({ ...area, width: 1024, height: 768 }))).toEqual({
      x: 0,
      y: 0,
      width: 1024,
      height: 768,
    });
  });

  it("moves bounds from a disconnected monitor onto the remaining display", () => {
    expect(fitWindowBounds({ x: -2000, y: 1500, width: 1600, height: 1200 }, area)).toEqual({
      x: 0,
      y: 0,
      width: 1600,
      height: 1080,
    });
  });

  it("saves normal bounds and presentation state before closing, then restores them", () => {
    vi.useFakeTimers();
    const file = stateFile();
    const bounds = { x: 80, y: 70, width: 1500, height: 950 };
    const window = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      getNormalBounds: () => bounds,
      isMaximized: () => true,
      isFullScreen: () => true,
      maximize: vi.fn(),
      setFullScreen: vi.fn(),
    });
    const onError = vi.fn();
    new DesktopWindowState(file).attach(window as unknown as BaseWindow, onError);
    window.emit("resize");
    window.emit("close");
    window.emit("closed");
    const restored = new DesktopWindowState(file);
    expect(restored.initialBounds(() => area)).toEqual(bounds);
    restored.attach(window as unknown as BaseWindow, onError);
    expect(window.maximize).toHaveBeenCalledOnce();
    expect(window.setFullScreen).toHaveBeenCalledWith(true);
    expect(onError).not.toHaveBeenCalled();
    vi.runAllTimers();
  });

  it("persists movement during the session without needing a clean quit", () => {
    vi.useFakeTimers();
    const file = stateFile();
    const bounds = { x: 50, y: 60, width: 1200, height: 800 };
    const window = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      getNormalBounds: () => bounds,
      isMaximized: () => false,
      isFullScreen: () => false,
    });
    new DesktopWindowState(file).attach(window as unknown as BaseWindow, vi.fn());
    window.emit("move");
    vi.advanceTimersByTime(200);
    expect(new DesktopWindowState(file).initialBounds(() => area)).toEqual(bounds);
  });

  it("uses defaults for malformed saved state", () => {
    const file = stateFile();
    for (const content of ['{"bounds":{"width":-1}}', "null", "{"]) {
      fs.writeFileSync(file, content);
      expect(new DesktopWindowState(file).initialBounds(() => area).width).toBe(1440);
    }
  });
});
