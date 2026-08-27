import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
