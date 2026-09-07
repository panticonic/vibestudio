import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runNpmInstall } from "./npmInstaller.js";

describe.runIf(process.platform === "linux")("sandboxed native npm builds", () => {
  it("compiles and links C++ lifecycle code while keeping host files inaccessible", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vibestudio-native-npm-"));
    const install = path.join(root, "install");
    const canary = path.join(root, "host-secret");
    try {
      await mkdir(install);
      await writeFile(canary, "private host state");
      await writeFile(
        path.join(install, "package.json"),
        JSON.stringify({
          name: "native-build-fixture",
          version: "1.0.0",
          private: true,
          scripts: { install: "node build.cjs" },
        })
      );
      await writeFile(
        path.join(install, "fixture.cc"),
        `
        #include <stdint.h>
        #include <functional>
        #include <iostream>
        int main() {
          std::function<uint32_t()> value = [] { return 42; };
          std::cout << value();
        }
      `
      );
      await writeFile(
        path.join(install, "build.cjs"),
        `
        const fs = require('node:fs');
        const { execFileSync } = require('node:child_process');
        let hostDenied = false;
        try { fs.readFileSync(${JSON.stringify(canary)}); }
        catch { hostDenied = true; }
        if (!hostDenied) throw new Error('Lifecycle code read private host state');
        execFileSync('/usr/bin/c++', ['fixture.cc', '-o', 'fixture'], {stdio:'inherit'});
        fs.writeFileSync('result', execFileSync('./fixture'));
      `
      );
      await runNpmInstall(install, {
        appRoot: fileURLToPath(new URL("../../../", import.meta.url)),
        ignoreScripts: false,
        timeout: 30_000,
      });
      expect(await readFile(path.join(install, "result"), "utf8")).toBe("42");
      expect(await readFile(canary, "utf8")).toBe("private host state");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
