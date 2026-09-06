import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getInstalledNodeRuntime } from "@vibestudio/shared/runtimePaths";
import { getCACertificates } from "node:tls";
import { prepareNativeRuntime } from "@vibestudio/shared/nativeRuntimeResources";

const appRoot = fileURLToPath(new URL("../../", import.meta.url));
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "native-runtime-resources-")));
  roots.push(root);
  return root;
}

describe("installed native runtime resources", () => {
  it("uses real installed Node without admitting the Electron host bundle", () => {
    const root = fixture();
    const contents = path.join(root, "Installed.app", "Contents");
    const resourcesPath = path.join(contents, "Resources");
    mkdirSync(resourcesPath, { recursive: true });
    mkdirSync(path.join(contents, "MacOS"));
    const executable = path.join(contents, "MacOS", "Installed");
    writeFileSync(executable, "installed executable fixture");
    const runtimeRoot = path.join(root, "runtime");
    mkdirSync(runtimeRoot);
    vi.stubGlobal(
      "process",
      Object.create(process, {
        execPath: { value: executable },
        versions: { value: { ...process.versions, electron: "test" } },
        resourcesPath: { value: resourcesPath },
        report: { value: { getReport: () => ({ sharedObjects: [] }) } },
      })
    );
    const runtime = prepareNativeRuntime({ appRoot, runtimeRoot });
    expect(runtime.readPaths).not.toContain(contents);
    expect(runtime.executable).not.toBe(executable);
    expect(runtime.environment).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(runtime.readPaths).not.toContain(root);
    expect(runtime.readPaths).not.toContain(path.dirname(contents));
  });
  it("prepares an executable runtime independently of any workspace", () => {
    const root = fixture();
    const runtime = prepareNativeRuntime({ appRoot, runtimeRoot: root });
    expect(runtime.readPaths).toContain(root);
    const trustPath = runtime.environment["NODE_EXTRA_CA_CERTS"]!;
    expect(path.dirname(trustPath)).toBe(root);
    expect(readFileSync(trustPath, "utf8")).toBe(
      [...new Set(getCACertificates("default"))].join("\n") + "\n"
    );
    expect(
      execFileSync(runtime.executable, ["-e", "process.stdout.write('runtime-ready')"], {
        env: { ...process.env, ...runtime.environment },
        encoding: "utf8",
      })
    ).toBe("runtime-ready");
    expect(runtime.environment).not.toHaveProperty("HOME");
    expect(runtime.environment).not.toHaveProperty("LOCALAPPDATA");
    if (process.platform === "win32")
      expect(runtime.executable.startsWith(root + path.sep)).toBe(true);
    else expect(runtime.executable).toBe(realpathSync(getInstalledNodeRuntime(appRoot).executable));
  });

  it.runIf(process.platform !== "win32")(
    "rejects an alias instead of treating an unowned path as its anchor",
    () => {
      const root = fixture();
      const real = path.join(root, "real");
      const alias = path.join(root, "alias");
      mkdirSync(real);
      symlinkSync(real, alias, "dir");
      expect(() => prepareNativeRuntime({ appRoot, runtimeRoot: alias })).toThrow(
        /canonical directory/
      );
    }
  );
});
