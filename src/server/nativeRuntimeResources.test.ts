import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareNativeRuntime } from "./nativeRuntimeResources.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "native-runtime-resources-")));
  roots.push(root);
  return root;
}

describe("installed native runtime resources", () => {
  it("prepares an executable runtime independently of any workspace", () => {
    const root = fixture();
    const runtime = prepareNativeRuntime({ runtimeRoot: root });
    expect(runtime.readPaths).toContain(root);
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
    else expect(runtime.executable).toBe(realpathSync(process.execPath));
  });

  it.runIf(process.platform !== "win32")(
    "rejects an alias instead of treating an unowned path as its anchor",
    () => {
      const root = fixture();
      const real = path.join(root, "real");
      const alias = path.join(root, "alias");
      mkdirSync(real);
      symlinkSync(real, alias, "dir");
      expect(() => prepareNativeRuntime({ runtimeRoot: alias })).toThrow(/canonical directory/);
    }
  );
});
