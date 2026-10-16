import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaunchEntry } from "@vibestudio/client-host-core";
import {
  commandLine,
  installLauncher,
  launcherAppUserModelId,
  removeLauncher,
  renderDesktopEntry,
  windowAppDetails,
  type LauncherEnvironment,
  type LauncherFs,
  type LauncherSpec,
} from "./launcherArtifacts.js";
import { LauncherService } from "./launcherService.js";
import { InstalledLaunchers } from "./installedLaunchers.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function memoryFs() {
  const files = new Map<string, { data: string; mode?: number }>();
  const fs: LauncherFs = {
    mkdir: async () => undefined,
    writeFile: async (file, data, mode) =>
      void files.set(file, { data, ...(mode ? { mode } : {}) }),
    copyFile: async (from, to) => void files.set(to, { data: `copy of ${from}` }),
    rm: async (target) => {
      for (const key of [...files.keys()])
        if (key === target || key.startsWith(`${target}/`)) files.delete(key);
    },
  };
  return { fs, files };
}

const entry = (clientId: string, intent: string, label: string, link: string): LaunchEntry => ({
  clientId,
  intent,
  label,
  link,
});

const chat: LauncherSpec = {
  clientId: "chat",
  title: "Chat",
  entries: [
    entry("chat", "open", "Chat", "vibestudio://c/chat/open"),
    entry(
      "chat",
      "open-conversation",
      "Standup",
      "vibestudio://c/chat/open-conversation?channel=c1"
    ),
  ],
};

function env(platform: LauncherEnvironment["platform"], extra: Partial<LauncherEnvironment> = {}) {
  const { fs, files } = memoryFs();
  const environment: LauncherEnvironment = {
    platform,
    command: ["/opt/Vibestudio App/vibestudio"],
    homeDir: "/home/me",
    appDataDir: "C:/Users/me/AppData/Roaming",
    iconPath: "/opt/icon.png",
    fs,
    ...extra,
  };
  return { environment, files };
}

describe("Linux launcher", () => {
  it("writes a desktop entry that opens the client through the app, with an action per entry", async () => {
    const { environment, files } = env("linux");
    const installed = await installLauncher(chat, environment);
    const file = "/home/me/.local/share/applications/app.vibestudio.Vibestudio.chat.desktop";
    expect(installed.paths).toEqual([file]);
    const text = files.get(file)!.data;
    expect(text).toContain("Name=Chat");
    expect(text).toContain('Exec="/opt/Vibestudio App/vibestudio" vibestudio://c/chat/open');
    expect(text).toContain("Actions=a0;");
    expect(text).toContain("[Desktop Action a0]\nName=Standup");
    expect(text).toContain("vibestudio://c/chat/open-conversation?channel=c1");
  });

  it("escapes what the Exec grammar treats as special", () => {
    const { environment } = env("linux", { command: ['/odd/"quote" $dir/app'] });
    expect(renderDesktopEntry(chat, environment)).toContain(
      'Exec="/odd/\\"quote\\" \\$dir/app" vibestudio://c/chat/open'
    );
  });

  it("removes exactly what it wrote", async () => {
    const { environment, files } = env("linux");
    const installed = await installLauncher(chat, environment);
    await removeLauncher(installed, environment.fs);
    expect(files.size).toBe(0);
  });
});

describe("Windows launcher", () => {
  it("writes a Start-menu shortcut carrying the client's own AppUserModelID", async () => {
    const writeShortcutLink = vi.fn(() => true);
    const { environment } = env("win32", { writeShortcutLink });
    const installed = await installLauncher(chat, environment);
    expect(installed.paths).toEqual([
      "C:/Users/me/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Vibestudio/Chat.lnk",
    ]);
    expect(writeShortcutLink).toHaveBeenCalledWith(installed.paths[0], "create", {
      target: "/opt/Vibestudio App/vibestudio",
      args: "vibestudio://c/chat/open",
      description: "Chat",
      icon: "/opt/icon.png",
      iconIndex: 0,
      appUserModelId: "app.vibestudio.Vibestudio.chat",
    });
  });

  it("fails when Windows refuses the shortcut", async () => {
    const { environment } = env("win32", { writeShortcutLink: () => false });
    await expect(installLauncher(chat, environment)).rejects.toThrow(/refused/);
  });

  it("gives a client's windows the identity the shortcut carries", () => {
    expect(
      windowAppDetails({ clientId: "chat", title: "Chat" }, ["C:\\App\\v.exe", "x y"], "i.png")
    ).toEqual({
      appId: launcherAppUserModelId("chat"),
      appIconPath: "i.png",
      relaunchCommand: 'C:\\App\\v.exe "x y" vibestudio://c/chat/open',
      relaunchDisplayName: "Chat",
    });
    expect(commandLine(["a b", 'c"d'])).toBe('"a b" "c\\"d"');
  });
});

describe("macOS launcher", () => {
  it("writes a launcher bundle whose executable opens the link", async () => {
    const { environment, files } = env("darwin", { icnsPath: "/res/icon.icns" });
    const installed = await installLauncher(chat, environment);
    const bundle = "/home/me/Applications/Chat.app";
    expect(installed.paths).toEqual([bundle]);
    expect(files.get(`${bundle}/Contents/Info.plist`)!.data).toContain(
      "<key>CFBundleIdentifier</key><string>app.vibestudio.Vibestudio.chat</string>"
    );
    expect(files.get(`${bundle}/Contents/Info.plist`)!.data).toContain("CFBundleIconFile");
    const launcher = files.get(`${bundle}/Contents/MacOS/launcher`)!;
    expect(launcher.data).toBe("#!/bin/sh\nexec /usr/bin/open 'vibestudio://c/chat/open'\n");
    expect(launcher.mode).toBe(0o755);
    expect(files.has(`${bundle}/Contents/Resources/icon.icns`)).toBe(true);
    await removeLauncher(installed, environment.fs);
    expect(files.size).toBe(0);
  });

  it("names no icon when the app ships none", async () => {
    const { environment, files } = env("darwin");
    await installLauncher(chat, environment);
    expect(files.get("/home/me/Applications/Chat.app/Contents/Info.plist")!.data).not.toContain(
      "CFBundleIconFile"
    );
  });
});

describe("launcher service", () => {
  function service(platform: LauncherEnvironment["platform"], accept = true) {
    const dir = mkdtempSync(join(tmpdir(), "launchers-"));
    cleanup.push(dir);
    const { environment, files } = env(platform, { writeShortcutLink: () => true });
    let clients = [{ clientId: "chat", title: "Chat", entries: chat.entries as LaunchEntry[] }];
    const records = new InstalledLaunchers(join(dir, "launchers.json"));
    const confirm = vi.fn(async () => accept);
    const launchers = new LauncherService({
      env: environment,
      records,
      clients: () => clients,
      confirm,
    });
    return {
      launchers,
      files,
      records,
      confirm,
      dir,
      setClients: (next: typeof clients) => (clients = next),
    };
  }
  const cleanup: string[] = [];
  afterEach(() => {
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("asks the person before it writes, and records what it wrote", async () => {
    const declined = service("linux", false);
    await expect(declined.launchers.install("chat")).resolves.toBe(false);
    expect(declined.files.size).toBe(0);

    const t = service("linux");
    await expect(t.launchers.install("chat")).resolves.toBe(true);
    expect(t.launchers.installed()).toEqual(["chat"]);
    // The record survives a restart.
    expect(new InstalledLaunchers(join(t.dir, "launchers.json")).list()).toHaveLength(1);
    await t.launchers.remove("chat");
    expect(t.files.size).toBe(0);
    expect(t.launchers.installed()).toEqual([]);
  });

  it("refuses a client this host cannot run", async () => {
    await expect(service("linux").launchers.install("ghost")).rejects.toThrow(/not a client/);
  });

  it("rewrites a launcher whose entries changed and removes one whose client disappeared", async () => {
    const t = service("linux");
    await t.launchers.install("chat");
    const file = "/home/me/.local/share/applications/app.vibestudio.Vibestudio.chat.desktop";

    t.setClients([
      {
        clientId: "chat",
        title: "Chat",
        entries: [entry("chat", "open", "Chat", "vibestudio://c/chat/open")],
      },
    ]);
    await t.launchers.reconcile();
    expect(t.files.get(file)!.data).not.toContain("Standup");

    t.setClients([]);
    await t.launchers.reconcile();
    expect(t.files.size).toBe(0);
    expect(t.launchers.installed()).toEqual([]);
  });

  it("removes the old shortcut when a title change moves it", async () => {
    const t = service("win32");
    t.records.set({ clientId: "chat", platform: "win32", fingerprint: "old", paths: ["old.lnk"] });
    t.files.set("old.lnk", { data: "x" });
    await t.launchers.reconcile();
    expect(t.files.has("old.lnk")).toBe(false);
  });
});
