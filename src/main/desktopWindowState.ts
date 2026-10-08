import * as fs from "node:fs";
import * as path from "node:path";
import type { BaseWindow, Rectangle } from "electron";

interface WindowState {
  bounds: Rectangle;
  maximized: boolean;
  fullscreen: boolean;
}

function readState(file: string): WindowState | null {
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as WindowState | null;
    if (!state || typeof state !== "object") return null;
    const b = state.bounds;
    if (
      !b ||
      ![b.x, b.y, b.width, b.height].every(Number.isSafeInteger) ||
      b.width <= 0 ||
      b.height <= 0 ||
      typeof state.maximized !== "boolean" ||
      typeof state.fullscreen !== "boolean"
    )
      return null;
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError)
      return null;
    throw error;
  }
}

/** Keep restored windows reachable when a monitor is removed or resized. */
export function fitWindowBounds(bounds: Rectangle, workArea: Rectangle): Rectangle {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  return {
    x: Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height)),
    width,
    height,
  };
}

export class DesktopWindowState {
  private readonly state: WindowState | null;

  constructor(private readonly file: string) {
    this.state = readState(file);
  }

  initialBounds(workAreaFor: (bounds: Rectangle | null) => Rectangle): Rectangle {
    const bounds = this.state?.bounds ?? { x: 0, y: 0, width: 1440, height: 900 };
    const area = workAreaFor(this.state?.bounds ?? null);
    return fitWindowBounds(
      this.state?.bounds ?? {
        ...bounds,
        x: area.x + Math.round((area.width - bounds.width) / 2),
        y: area.y + Math.round((area.height - bounds.height) / 2),
      },
      area
    );
  }

  attach(
    window: BaseWindow,
    onError: (error: unknown) => void,
    isFullscreen = () => window.isFullScreen()
  ): void {
    // Apply presentation state only after creating the normal window bounds.
    if (this.state?.maximized) window.maximize();
    if (this.state?.fullscreen) window.setFullScreen(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      clearTimeout(timer);
      timer = undefined;
      if (window.isDestroyed()) return;
      const state: WindowState = {
        bounds: window.getNormalBounds(),
        maximized: window.isMaximized(),
        fullscreen: isFullscreen(),
      };
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(state), { mode: 0o600 });
        fs.renameSync(`${this.file}.tmp`, this.file);
      } catch (error) {
        onError(error);
      }
    };
    const scheduleSave = () => {
      clearTimeout(timer);
      timer = setTimeout(save, 200);
    };
    window.on("move", scheduleSave);
    window.on("resize", scheduleSave);
    window.on("maximize", scheduleSave);
    window.on("unmaximize", scheduleSave);
    window.on("enter-full-screen", scheduleSave);
    window.on("leave-full-screen", scheduleSave);
    window.on("close", save);
    window.on("closed", () => clearTimeout(timer));
  }
}
