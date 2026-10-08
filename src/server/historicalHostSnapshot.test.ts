import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  applyWorkspaceHostRuntimeEnv,
  buildWorkspaceChildArgs,
  buildWorkspaceChildEnv,
} from "./hubServer.js";
import { resolveHistoricalWorkspaceHost } from "./historicalWorkspaceHost.js";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  artifactRootFromModuleUrl,
  publishHistoricalHostSnapshot,
} from "../../scripts/historical-host-snapshot.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(version: string, content: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-host-snapshot-test-"));
  roots.push(root);
  const app = path.join(root, "installed");
  const central = path.join(root, "state");
  fs.mkdirSync(path.join(app, "dist"), { recursive: true });
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ version }));
  fs.writeFileSync(path.join(app, "dist", "server.mjs"), content);
  const executable = path.join(root, "node");
  fs.writeFileSync(executable, "#!/usr/bin/env node\nprocess.stdout.write(process.version);\n");
  fs.chmodSync(executable, 0o500);
  return { app, central, executable };
}

describe("historical host snapshots", () => {
  it("publishes a self-contained epoch directory with its marker", () => {
    const input = fixture("2.4.1", "first");
    const result = publishHistoricalHostSnapshot({
      centralDataPath: input.central,
      artifactRoot: input.app,
      appRoot: input.app,
      serverEntry: path.join(input.app, "dist", "server.mjs"),
      executable: input.executable,
      appVersion: "2.4.1",
      platform: "linux",
    });

    expect(result.destination).toBe(path.join(input.central, "host-versions", "2"));
    expect(
      fs.readFileSync(path.join(result.destination, "app", "dist", "server.mjs"), "utf8")
    ).toBe("first");
    expect(
      JSON.parse(fs.readFileSync(path.join(result.destination, "workspace-host.json"), "utf8"))
    ).toMatchObject({
      systemEpoch: 2,
      appVersion: "2.4.1",
      runtimeMode: "node",
      appRoot: "app",
      serverEntry: path.join("app", "dist", "server.mjs"),
    });
  });

  it("retains the complete bundled macOS Electron runtime and its symlink topology", () => {
    const input = fixture("2.4.1", "first");
    const electronRoot = path.join(input.app, "node_modules", "electron");
    const executableRelative = path.join("Electron.app", "Contents", "MacOS", "Electron");
    const electronExecutable = path.join(electronRoot, "dist", executableRelative);
    fs.mkdirSync(path.dirname(electronExecutable), { recursive: true });
    fs.writeFileSync(
      electronExecutable,
      "#!/usr/bin/env node\nprocess.stdout.write(process.version);\n"
    );
    fs.chmodSync(electronExecutable, 0o500);
    fs.writeFileSync(path.join(electronRoot, "path.txt"), executableRelative);
    const versions = path.join(
      electronRoot,
      "dist",
      "Electron.app",
      "Contents",
      "Frameworks",
      "Example.framework",
      "Versions"
    );
    fs.mkdirSync(path.join(versions, "A"), { recursive: true });
    fs.symlinkSync("A", path.join(versions, "Current"));

    const result = publishHistoricalHostSnapshot({
      centralDataPath: input.central,
      artifactRoot: input.app,
      appRoot: input.app,
      serverEntry: path.join(input.app, "dist", "server.mjs"),
      executable: input.executable,
      appVersion: "2.4.1",
      platform: "darwin",
    });

    expect(result.marker.runtimeMode).toBe("electron-node");
    expect(result.marker.executable).toContain("Electron.app");
    expect(
      fs
        .lstatSync(
          path.join(
            result.destination,
            "app",
            "node_modules",
            "electron",
            "dist",
            "Electron.app",
            "Contents",
            "Frameworks",
            "Example.framework",
            "Versions",
            "Current"
          )
        )
        .isSymbolicLink()
    ).toBe(true);
  });

  it("decodes spaces when deriving the default artifact root from a module URL", () => {
    const modulePath = path.join(os.tmpdir(), "Vibestudio With Spaces", "scripts", "snapshot.mjs");
    expect(artifactRootFromModuleUrl(pathToFileURL(modulePath).href)).toBe(
      path.join(os.tmpdir(), "Vibestudio With Spaces")
    );
  });

  it("refuses a macOS snapshot that has no self-contained runtime bundle", () => {
    const input = fixture("2.4.1", "first");
    expect(() =>
      publishHistoricalHostSnapshot({
        centralDataPath: input.central,
        artifactRoot: input.app,
        appRoot: input.app,
        serverEntry: path.join(input.app, "dist", "server.mjs"),
        executable: input.executable,
        appVersion: "2.4.1",
        platform: "darwin",
      })
    ).toThrow("requires the bundled Electron runtime or a complete .app runtime bundle");
    expect(fs.existsSync(path.join(input.central, "host-versions", "2"))).toBe(false);
  });

  it("does not publish an artifact with a symlink outside its dependency closure", () => {
    const input = fixture("2.4.1", "first");
    fs.symlinkSync(input.executable, path.join(input.app, "external-runtime"));

    expect(() =>
      publishHistoricalHostSnapshot({
        centralDataPath: input.central,
        artifactRoot: input.app,
        appRoot: input.app,
        serverEntry: path.join(input.app, "dist", "server.mjs"),
        executable: input.executable,
        appVersion: "2.4.1",
      })
    ).toThrow("symlink escapes its artifact root");
  });

  it("replaces an epoch with the final compatible patch", () => {
    const input = fixture("2.4.1", "first");
    const publish = (version: string) =>
      publishHistoricalHostSnapshot({
        centralDataPath: input.central,
        artifactRoot: input.app,
        appRoot: input.app,
        serverEntry: path.join(input.app, "dist", "server.mjs"),
        executable: input.executable,
        appVersion: version,
        platform: "linux",
      });
    publish("2.4.1");
    fs.writeFileSync(path.join(input.app, "dist", "server.mjs"), "final");
    publish("2.9.0");

    const destination = path.join(input.central, "host-versions", "2");
    expect(fs.readFileSync(path.join(destination, "app", "dist", "server.mjs"), "utf8")).toBe(
      "final"
    );
    expect(fs.existsSync(path.join(input.central, "host-versions", ".2.previous"))).toBe(false);
  });
});

it("retains a packaged Electron executable with its entire application tree", () => {
  const input = fixture("2.4.1", "server");
  const executable = path.join(input.app, "vibestudio");
  fs.copyFileSync(input.executable, executable);
  fs.chmodSync(executable, 0o755);
  const result = publishHistoricalHostSnapshot({
    centralDataPath: input.central,
    artifactRoot: input.app,
    appRoot: input.app,
    serverEntry: path.join(input.app, "dist", "server.mjs"),
    executable,
    appVersion: "2.4.1",
    runtimeMode: "electron-node",
  });
  expect(result.marker.runtimeMode).toBe("electron-node");
  expect(result.marker.executable).toBe(path.join("app", "vibestudio"));
  expect(fs.existsSync(path.join(result.destination, result.marker.serverEntry))).toBe(true);
});

it("launches a retained server with its own artifacts after the original installation is replaced", async () => {
  const input = fixture(
    "1.2.0",
    `
    import { readFileSync } from "node:fs";
    import { join } from "node:path";
    const artifacts = process.env.VIBESTUDIO_HOST_ARTIFACT_ROOT;
    console.log(JSON.stringify({
      hostVersion: process.env.VIBESTUDIO_APP_VERSION,
      currentVersion: process.env.VIBESTUDIO_CURRENT_APP_VERSION,
      bundle: readFileSync(join(artifacts, "internal-do.bundle.mjs"), "utf8"),
      worker: readFileSync(join(artifacts, "workerd-programs", "main.mjs"), "utf8"),
      hubBundle: process.env.VIBESTUDIO_INTERNAL_DO_BUNDLE_PATH ?? null,
      appRoot: process.env.VIBESTUDIO_APP_ROOT,
    }));
  `
  );
  fs.mkdirSync(path.join(input.app, "dist", "workerd-programs"));
  fs.writeFileSync(path.join(input.app, "dist", "internal-do.bundle.mjs"), "retained bundle");
  fs.writeFileSync(path.join(input.app, "dist", "workerd-programs", "main.mjs"), "retained worker");
  publishHistoricalHostSnapshot({
    centralDataPath: input.central,
    artifactRoot: input.app,
    appRoot: input.app,
    serverEntry: path.join(input.app, "dist", "server.mjs"),
    executable: process.execPath,
    appVersion: "1.2.0",
    platform: "linux",
  });
  const launchSet = resolveHistoricalWorkspaceHost(path.join(input.central, "host-versions"), 1);
  fs.rmSync(input.app, { recursive: true });
  const env = buildWorkspaceChildEnv({
    baseEnv: {
      ...process.env,
      VIBESTUDIO_HOST_ARTIFACT_ROOT: path.join(input.app, "new-generation"),
      VIBESTUDIO_INTERNAL_DO_BUNDLE_PATH: path.join(input.app, "new-hub-bundle"),
      ESBUILD_BINARY_PATH: path.join(input.app, "new-esbuild"),
    },
    appRoot: launchSet.appRoot,
    workspaceName: "retained-integration",
    workspaceId: "ws_retained_integration",
    hubUrl: "http://127.0.0.1:1",
    identityDbPath: path.join(input.central, "identity.db"),
    workspaceChildToken: "test-token",
  });
  applyWorkspaceHostRuntimeEnv(env, launchSet, "2.0.0");
  const { stdout } = await promisify(execFile)(
    launchSet.executable,
    buildWorkspaceChildArgs({
      entry: launchSet.serverEntry,
      workspaceName: "retained-integration",
      appRoot: launchSet.appRoot,
      readyFile: path.join(input.central, "ready.json"),
    }),
    { env, cwd: launchSet.appRoot }
  );
  expect(JSON.parse(stdout)).toEqual({
    hostVersion: "1.2.0",
    currentVersion: "2.0.0",
    bundle: "retained bundle",
    worker: "retained worker",
    hubBundle: null,
    appRoot: launchSet.appRoot,
  });
  expect(env["ESBUILD_BINARY_PATH"]).toBeUndefined();
});
