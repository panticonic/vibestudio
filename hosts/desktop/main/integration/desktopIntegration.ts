import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  app,
  dialog,
  globalShortcut,
  Menu,
  nativeImage,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from "electron";
import { z } from "zod";
import {
  invokeBackgroundIntent,
  type Call,
  type ClientLaunchEntries,
  type SnapshotClient,
} from "@vibestudio/client-host-core";
import type { ClientCapability, HostDescriptor } from "@vibestudio/workspace-contracts/clients";
import { createDevLogger } from "@vibestudio/dev-log";
import type { ClientIntent } from "../clientIntents.js";
import { parseClientTrayModel, toElectron } from "../clientMenu.js";
import type { ClientWindow, ClientWindows } from "../clientWindow.js";
import { AskWindows } from "./askWindow.js";
import { ClientIntegration } from "./clientIntegration.js";
import { InstalledLaunchers } from "./installedLaunchers.js";
import { buildDockMenu, buildJumpList } from "./launchSurfaces.js";
import type { LauncherEnvironment, LauncherFs, LauncherPlatform } from "./launcherArtifacts.js";
import { LauncherService } from "./launcherService.js";
import { ShortcutRegistry } from "./shortcutRegistry.js";
import { ClientBadges, ClientTrays } from "./trayBadge.js";

const log = createDevLogger("DesktopIntegration");

const nodeLauncherFs: LauncherFs = {
  mkdir: async (dir) => void (await fsp.mkdir(dir, { recursive: true })),
  writeFile: (file, data, mode) => fsp.writeFile(file, data, mode === undefined ? {} : { mode }),
  copyFile: (from, to) => fsp.copyFile(from, to),
  rm: (target) => fsp.rm(target, { recursive: true, force: true }),
};

const ShortcutRequestSchema = z
  .object({
    id: z.string().min(1).max(64),
    accelerator: z.string().min(1).max(64),
    intent: z.string().min(1).max(64),
    params: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export interface DesktopIntegrationDeps {
  userDataPath: string;
  /** The command that starts this app (the executable, or electron and the app path). */
  command: readonly string[];
  iconPath: string;
  /** An `.icns` for macOS launcher bundles, when the app ships one. */
  icnsPath?: string;
  askPreloadPath: string;
  /** `clients.integrationSnapshot` for this host. */
  fetchSnapshot(): Promise<{ clients: readonly SnapshotClient[] }>;
  call: Call;
  descriptor: HostDescriptor;
  windows: ClientWindows;
  /** Foreground-intent launching of the client host, which exists once a session does. */
  openIntentWindow(clientId: string, intent: ClientIntent): Promise<void>;
  openLink(link: string): Promise<boolean>;
  notify(title: string, message: string): void;
  /** Replaces the confirmation dialog for hosts that have no person at the screen (the test driver). */
  confirmLauncher?(title: string): Promise<boolean>;
}

type RequireCapability = (
  event: IpcMainInvokeEvent,
  capability: ClientCapability,
  channel: string
) => ClientWindow;

/**
 * Everything the desktop host projects a client onto the OS with: launchers
 * (`integration.install`), the Dock menu and jump list, global shortcuts, tray
 * icons and the badge. The pure parts are tested on their own; this wires them to
 * Electron.
 */
export function createDesktopIntegration(deps: DesktopIntegrationDeps) {
  const platform = process.platform;
  const supported: LauncherPlatform | null =
    platform === "linux" || platform === "win32" || platform === "darwin" ? platform : null;
  const env: LauncherEnvironment = {
    platform: supported ?? "linux",
    command: deps.command,
    homeDir: os.homedir(),
    appDataDir: app.getPath("appData"),
    iconPath: deps.iconPath,
    ...(deps.icnsPath ? { icnsPath: deps.icnsPath } : {}),
    fs: nodeLauncherFs,
    writeShortcutLink: (file, operation, options) =>
      shell.writeShortcutLink(file, operation, options),
  };
  const launchers = new LauncherService({
    env,
    records: new InstalledLaunchers(path.join(deps.userDataPath, "installed-launchers.json")),
    clients: () => integration.entries(),
    confirm: async (title) => {
      if (supported === null) throw new Error(`Launchers are not supported on ${platform}`);
      if (deps.confirmLauncher) return deps.confirmLauncher(title);
      const { response } = await dialog.showMessageBox({
        type: "question",
        title: "Add a launcher?",
        message: `Add "${title}" to your applications?`,
        detail:
          "It will open this app and start the client. You can remove it from the same place.",
        buttons: ["Add", "Cancel"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      return response === 0;
    },
  });
  const ask = new AskWindows(deps.askPreloadPath);
  const shortcuts: ShortcutRegistry = new ShortcutRegistry({
    shortcuts: globalShortcut,
    validate: (clientId, request) => integration.validateShortcut(clientId, request),
    run: (clientId, request) => {
      try {
        integration.runShortcut(clientId, request);
      } catch (error) {
        deps.notify(
          "A shortcut could not run",
          error instanceof Error ? error.message : String(error)
        );
      }
    },
  });
  const integration: ClientIntegration = new ClientIntegration({
    fetchSnapshot: deps.fetchSnapshot,
    launchers,
    shortcuts: () => shortcuts,
    applySurfaces: applySurfaces,
    openForeground: (clientId, intent) => {
      deps.openIntentWindow(clientId, intent).catch((error: unknown) => {
        deps.notify(
          "A shortcut could not open",
          error instanceof Error ? error.message : String(error)
        );
      });
    },
    invokeBackground: async (request) =>
      (await invokeBackgroundIntent(deps.call, deps.descriptor, request)).text,
    ask,
  });

  const lastWindow = (clientId: string) => deps.windows.windowsOf(clientId).at(-1);
  const trays = new ClientTrays({
    createTray: () =>
      new Tray(nativeImage.createFromPath(deps.iconPath).resize({ width: 16, height: 16 })),
    buildMenu: (model, dispatch) => Menu.buildFromTemplate(toElectron(model.items, dispatch)),
    activate: (clientId) => void deps.windows.focus(clientId),
    action: (clientId, actionId) => lastWindow(clientId)?.send("vibestudio:tray-action", actionId),
  });
  const badges = new ClientBadges(app);

  /** The Dock menu (macOS) and jump list (Windows), from the clients' launch entries. */
  function applySurfaces(clients: readonly ClientLaunchEntries[]): void {
    if (process.platform === "darwin") {
      const sections = buildDockMenu(
        clients,
        deps.windows.all().map((window) => ({
          clientId: window.spec.clientId,
          title: window.spec.title,
        }))
      );
      const open = (link: string) => () => {
        deps.openLink(link).catch((error: unknown) => {
          deps.notify("Couldn't open that", error instanceof Error ? error.message : String(error));
        });
      };
      app.dock?.setMenu(
        Menu.buildFromTemplate(
          sections.map((section) =>
            section.kind === "client"
              ? section.items.length === 1
                ? { label: section.title, click: open(section.items[0]!.link) }
                : {
                    label: section.title,
                    submenu: section.items.map((item) => ({
                      label: item.label,
                      click: open(item.link),
                    })),
                  }
              : {
                  label: "Open windows",
                  submenu: section.items.map((item) => ({
                    label: item.label,
                    click: () => void deps.windows.focus(item.clientId),
                  })),
                }
          )
        )
      );
    } else if (process.platform === "win32") {
      const result = app.setJumpList(
        buildJumpList(clients, { command: deps.command, iconPath: deps.iconPath })
      );
      if (result !== "ok") throw new Error(`Windows did not accept the jump list: ${result}`);
    }
  }

  return {
    integration,
    launchers,
    shortcuts,
    trays,
    badges,

    /** Re-apply the OS menus after client windows opened or closed. */
    windowsChanged(): void {
      try {
        applySurfaces(integration.entries());
      } catch (error) {
        log.warn(
          `Could not refresh the OS menus: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },

    /** A client stopped or was retired: everything it registered goes with it. */
    clientStopped(clientId: string): void {
      shortcuts.unregisterClient(clientId);
      trays.clear(clientId);
      badges.clear(clientId);
    },

    /** The capabilities enforced for a running client changed. */
    capabilitiesChanged(clientId: string, capabilities: readonly ClientCapability[]): void {
      if (!capabilities.includes("global-shortcut")) shortcuts.unregisterClient(clientId);
      if (!capabilities.includes("tray")) trays.clear(clientId);
      if (!capabilities.includes("badge")) badges.clear(clientId);
    },

    /** The bridge's handlers; each is gated by the capability that governs it. */
    registerIpc(
      handle: (
        channel: string,
        handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
      ) => void,
      require: RequireCapability
    ): void {
      const text = (value: unknown, what: string): string => {
        if (typeof value !== "string" || value.length === 0) throw new Error(`${what} is required`);
        return value;
      };
      handle("vibestudio:integration:install", async (event, clientId) => {
        require(event, "integration.install", "vibestudio:integration:install");
        return { installed: await launchers.install(text(clientId, "A client id")) };
      });
      handle("vibestudio:integration:remove", async (event, clientId) => {
        require(event, "integration.install", "vibestudio:integration:remove");
        await launchers.remove(text(clientId, "A client id"));
      });
      handle("vibestudio:integration:installed", (event) => {
        require(event, "integration.install", "vibestudio:integration:installed");
        return launchers.installed();
      });
      handle("vibestudio:shortcut:register", (event, request) => {
        const window = require(event, "global-shortcut", "vibestudio:shortcut:register");
        shortcuts.register(window.spec.clientId, ShortcutRequestSchema.parse(request));
      });
      handle("vibestudio:shortcut:unregister", (event, id) => {
        const window = require(event, "global-shortcut", "vibestudio:shortcut:unregister");
        shortcuts.unregister(window.spec.clientId, text(id, "A shortcut id"));
      });
      handle("vibestudio:shortcut:list", (event) => {
        const window = require(event, "global-shortcut", "vibestudio:shortcut:list");
        return shortcuts.list(window.spec.clientId);
      });
      handle("vibestudio:tray:set", (event, model) => {
        const window = require(event, "tray", "vibestudio:tray:set");
        trays.set(window.spec.clientId, parseClientTrayModel(model));
      });
      handle("vibestudio:tray:clear", (event) => {
        trays.clear(require(event, "tray", "vibestudio:tray:clear").spec.clientId);
      });
      handle("vibestudio:badge:set", (event, count) => {
        badges.set(require(event, "badge", "vibestudio:badge:set").spec.clientId, count);
      });
    },
  };
}

export type DesktopIntegration = ReturnType<typeof createDesktopIntegration>;
