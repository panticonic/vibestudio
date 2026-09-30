import { BrowserWindow, desktopCapturer, dialog, ipcMain, webContents } from "electron";
import type {
  DesktopCapturerSource,
  DisplayMediaRequestHandlerHandlerRequest,
  Streams,
} from "electron";

const channel = "vibestudio:display-capture-picker";

/** Trusted source inventory never crosses into the requesting page. */
export class DisplayCapturePicker {
  private readonly pending = new Map<
    number,
    {
      sources: DesktopCapturerSource[];
      origin: string;
      audioAvailable: boolean;
      choose(index: unknown, audio: unknown): void;
    }
  >();

  constructor(private readonly paths: { htmlPath: string; preloadPath: string }) {
    ipcMain.handle(channel, (event, action: unknown, index?: unknown, audio?: unknown) => {
      const entry = this.pending.get(event.sender.id);
      if (!entry || event.senderFrame !== event.sender.mainFrame)
        throw new Error("Untrusted capture picker");
      if (action === "snapshot")
        return {
          origin: entry.origin,
          audioAvailable: entry.audioAvailable,
          sources: entry.sources.map((source, index) => ({
            index,
            name: source.name,
            thumbnail: source.thumbnail.toDataURL(),
            kind: source.id.startsWith("screen:") ? "Screen" : "Window",
          })),
        };
      if (action === "choose") return entry.choose(index, audio);
      throw new Error("Unknown capture picker action");
    });
  }

  readonly handle = (
    request: DisplayMediaRequestHandlerHandlerRequest,
    callback: (streams: Streams) => void
  ): void => {
    let delivered = false;
    const finish = (streams: Streams) => {
      if (delivered) return;
      delivered = true;
      callback(streams);
    };
    void this.pick(request)
      .then(finish, () => finish({}))
      .catch(() => {
        // Electron may retire the requesting frame before its callback is delivered.
      });
  };

  async pick(request: DisplayMediaRequestHandlerHandlerRequest): Promise<Streams> {
    const frame = request.frame;
    const owner = frame ? webContents.fromFrame(frame) : null;
    if (
      !frame ||
      !owner ||
      owner.isDestroyed() ||
      frame !== owner.mainFrame ||
      !request.userGesture ||
      !request.videoRequested
    )
      return {};
    const url = owner.getURL();
    if (new URL(url).origin !== new URL(request.securityOrigin).origin) return {};
    return new Promise<Streams>((resolve) => {
      let picker: BrowserWindow | null = null;
      let finished = false;
      const finish = (streams: Streams = {}) => {
        if (finished) return;
        finished = true;
        if (!owner.isDestroyed()) {
          owner.off("did-start-navigation", navigation);
          owner.off("destroyed", finish);
        }
        if (picker) {
          this.pending.delete(picker.webContents.id);
          if (!picker.isDestroyed()) picker.destroy();
        }
        resolve(streams);
      };
      const navigation = (
        _event: Electron.Event,
        _url: string,
        inPlace: boolean,
        main: boolean
      ) => {
        if (main && !inPlace) finish();
      };
      owner.on("did-start-navigation", navigation);
      owner.once("destroyed", finish);
      void (async () => {
        const sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: { width: 320, height: 180 },
        });
        if (finished) return;
        if (!sources.length) return finish();
        // With PipeWire, getSources itself opens the desktop portal chooser
        // and returns the single source the user selected. Do not ask again.
        if (process.platform === "linux" && sources.length === 1) {
          return finish({ video: sources[0] });
        }
        const parent = BrowserWindow.fromWebContents(owner);
        picker = new BrowserWindow({
          title: "Choose what to share",
          width: 820,
          height: 640,
          show: false,
          ...(parent ? { parent } : {}),
          webPreferences: {
            preload: this.paths.preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });
        picker.setContentProtection(true);
        picker.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        picker.webContents.on("will-navigate", (event) => event.preventDefault());
        const audioAvailable = request.audioRequested && process.platform === "win32";
        this.pending.set(picker.webContents.id, {
          sources,
          origin: new URL(url).origin,
          audioAvailable,
          choose: (index, audio) => {
            if (index === null) return finish();
            if (!Number.isInteger(index) || typeof index !== "number")
              throw new Error("Invalid source selection");
            const source = sources[index];
            if (
              !source ||
              owner.isDestroyed() ||
              owner.getURL() !== url ||
              owner.mainFrame !== frame
            )
              return finish();
            finish({
              video: source,
              ...(audio === true && audioAvailable ? { audio: "loopback" as const } : {}),
            });
          },
        });
        picker.once("closed", () => finish());
        await picker.loadFile(this.paths.htmlPath);
        if (!finished) {
          picker.show();
          picker.focus();
        }
      })().catch(() => {
        if (!finished) {
          void dialog.showMessageBox({
            type: "warning",
            title: "Screen sharing unavailable",
            message: "Could not open the screen-sharing chooser.",
            detail:
              "Check screen-recording permissions in system privacy settings, then try again.",
          });
        }
        finish();
      });
    });
  }
}
