import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assertNativePrerequisites } from "@vibestudio/process-adapter/native-launch";
import { installedClaudeCli, prepareInstalledClaudeLaunch } from "./claudeInstalledLaunch.js";
import {
  collectInstalledRuntimeReadRoots,
  getNativeExecutionInstallation,
  getInstalledNodeRuntime,
} from "./runtimePaths.js";
import type { MaterializedClaudeLaunch } from "./claudeLaunchProfile.js";

vi.mock("@vibestudio/process-adapter/native-launch", async (original) => ({
  ...(await original<typeof import("@vibestudio/process-adapter/native-launch")>()),
  assertNativePrerequisites: vi.fn().mockResolvedValue(undefined),
}));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "installed Claude & app ")));
  roots.push(root);
  const appRoot = path.join(root, "app.asar");
  const physicalRoot = appRoot + ".unpacked";
  const entry = path.join(physicalRoot, "dist", "cli", "client.mjs");
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, "export {};");
  const installed = getInstalledNodeRuntime(fileURLToPath(new URL("../../../", import.meta.url)));
  const nodeRoot = path.join(physicalRoot, "dist", "node", `${process.platform}-${process.arch}`);
  mkdirSync(path.dirname(nodeRoot), { recursive: true });
  symlinkSync(installed.root, nodeRoot, process.platform === "win32" ? "junction" : "dir");
  return { root, appRoot, physicalRoot, entry };
}

it("selects the physical packaged CLI and installed Node executable without shell quoting or guest PATH", () => {
  const f = fixture();
  vi.stubEnv("PATH", path.join(f.root, "untrusted command lookup"));
  const invocation = installedClaudeCli(f.appRoot);
  expect(invocation.command).toBe(getInstalledNodeRuntime(f.appRoot).executable);
  expect(invocation.args).toEqual([f.entry]);
  expect(invocation.environment).toEqual({ VIBESTUDIO_APP_ROOT: f.appRoot });
});

it("uses standalone Node even in Electron and rejects missing installed entry bytes", () => {
  const f = fixture();
  const electronDescriptor = Object.getOwnPropertyDescriptor(process.versions, "electron");
  Object.defineProperty(process.versions, "electron", { configurable: true, value: "fixture" });
  try {
    expect(installedClaudeCli(f.appRoot).environment).toEqual({
      VIBESTUDIO_APP_ROOT: f.appRoot,
    });
  } finally {
    if (electronDescriptor) Object.defineProperty(process.versions, "electron", electronDescriptor);
    else Reflect.deleteProperty(process.versions, "electron");
  }
  expect(() => installedClaudeCli(path.join(f.root, "missing app"))).toThrow();
  rmSync(f.entry);
  mkdirSync(f.entry);
  expect(() => installedClaudeCli(f.appRoot)).toThrow(/entry must be a file/);
  vi.stubEnv("VIBESTUDIO_APP_ROOT", undefined);
  expect(() => installedClaudeCli()).toThrow(/installed Vibestudio application/);
});

it("admits the installed CLI and runtime library closure while separating context and writable profile", async () => {
  const f = fixture();
  const profileDir = path.join(f.root, "profile");
  const context = path.join(f.root, "context");
  mkdirSync(profileDir);
  mkdirSync(context);
  const launch: MaterializedClaudeLaunch = {
    profileDir,
    argv: [process.execPath, "literal & argument"],
    cliCredentialPath: path.join(profileDir, "credential.json"),
    credentialState: null,
    env: {
      VIBESTUDIO_APP_ROOT: f.appRoot,
      VIBESTUDIO_CONTEXT_ID: "context",
      VIBESTUDIO_CHANNEL_ID: "channel",
      VIBESTUDIO_ENTITY_ID: "entity",
      VIBESTUDIO_VESSEL_REF: "do:fixture",
      VIBESTUDIO_LAUNCH_PROFILE: profileDir,
      CLAUDE_CONFIG_DIR: path.join(profileDir, "claude-config"),
    },
  };
  const confined = await prepareInstalledClaudeLaunch(launch, context, f.appRoot);
  const installation = getNativeExecutionInstallation(f.appRoot);
  if (installation.mechanism === "host-process") {
    expect(confined.command).toBe(realpathSync(process.execPath));
    expect(confined.args).toEqual(["literal & argument"]);
    expect(confined.env["HOME"]).toBe(path.join(profileDir, "home"));
  } else {
    expect(confined.command).toBe(installation.launcher);
    const config = JSON.parse(Buffer.from(confined.args[1]!, "base64").toString());
    expect(config.filesystem.readonlyPaths).toContain(f.physicalRoot);
    expect(config.filesystem.readonlyPaths).toContain(context);
    for (const directory of collectInstalledRuntimeReadRoots([process.execPath]))
      expect(config.filesystem.readonlyPaths).toContain(directory);
    expect(config.filesystem.readonlyPaths).not.toContain(path.parse(f.root).root);
    expect(config.filesystem.readwritePaths).toEqual(
      process.platform === "darwin" ? [profileDir, "/dev"] : [profileDir]
    );
    expect(config.process.cwd).toBe(context);
    expect(config.process.env).toContain(`VIBESTUDIO_APP_ROOT=${f.appRoot}`);
    expect(config.process.env).toContain(`HOME=${path.join(profileDir, "home")}`);
  }
  expect(assertNativePrerequisites).toHaveBeenCalledWith({
    installation,
    environment: confined.env,
  });
});
