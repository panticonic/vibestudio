import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

for (const scenario of ["development", "installed", "sign-failure", "verify-failure"]) {
  test(`branded bundle signing contract: ${scenario}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "branded-electron-test-"));
    try {
      fs.mkdirSync(path.join(root, "scripts"));
      fs.copyFileSync(
        new URL("./branded-electron.mjs", import.meta.url),
        path.join(root, "scripts", "branded-electron.mjs")
      );
      const moduleRoot = path.join(root, "node_modules", "electron");
      const bundle = path.join(moduleRoot, "Electron.app");
      fs.mkdirSync(path.join(bundle, "Contents", "MacOS"), { recursive: true });
      fs.writeFileSync(path.join(bundle, "Contents", "Info.plist"), "<plist><dict></dict></plist>");
      fs.writeFileSync(path.join(bundle, "Contents", "MacOS", "Electron"), "synthetic binary");
      fs.writeFileSync(
        path.join(moduleRoot, "package.json"),
        '{"version":"1.0.0","main":"index.cjs"}'
      );
      fs.writeFileSync(
        path.join(moduleRoot, "index.cjs"),
        `module.exports=${JSON.stringify(path.join(bundle, "Contents", "MacOS", "Electron"))}`
      );
      const bin = path.join(root, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(
        path.join(bin, "codesign"),
        `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(process.env.SIGN_LOG,JSON.stringify(args)+'\\n');
if((process.env.SCENARIO==='sign-failure' && args.includes('--sign')) || (process.env.SCENARIO==='verify-failure' && args.includes('--verify'))) process.exit(1);
`,
        { mode: 0o700 }
      );
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `Object.defineProperty(process,'platform',{value:'darwin'});const m=await import(${JSON.stringify(path.join(root, "scripts", "branded-electron.mjs"))});m.resolveElectronExecutableForVibestudio({installed:${scenario === "installed"}});`,
        ],
        {
          env: {
            ...process.env,
            HOME: root,
            PATH: `${bin}${path.delimiter}${process.env.PATH}`,
            SIGN_LOG: path.join(root, "sign.log"),
            SCENARIO: scenario,
          },
          encoding: "utf8",
        }
      );
      const calls = fs
        .readFileSync(path.join(root, "sign.log"), "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.deepEqual(calls[0].slice(0, 4), ["--force", "--deep", "--sign", "-"]);
      if (scenario !== "sign-failure")
        assert.deepEqual(calls[1].slice(0, 3), ["--verify", "--deep", "--strict"]);
      const cache =
        scenario === "installed"
          ? path.join(root, "Library", "Application Support", "vibestudio", "electron-cache")
          : path.join(root, ".cache", "vibestudio-electron");
      const marker = path.join(cache, `darwin-${process.arch}-1.0.0`, "metadata.json");
      assert.equal(fs.existsSync(marker), !scenario.endsWith("failure"));
      assert.equal(result.status === 0, !scenario.endsWith("failure"), result.stderr);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
