import { expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runNpmInstall } from "./npmInstaller.js";

it("runs real npm lifecycle scripts with private files and no owner environment", async () => {
  const appRoot = realpathSync.native(fileURLToPath(new URL("../../../", import.meta.url)));
  const root = realpathSync.native(
    mkdtempSync(path.join(os.homedir(), ".vibestudio-npm-containment-"))
  );
  const install = path.join(root, "install");
  const canary = path.join(root, "host-secret");
  mkdirSync(install);
  writeFileSync(canary, "unchanged");
  writeFileSync(
    path.join(install, "package.json"),
    JSON.stringify({
      name: "contained-lifecycle-fixture",
      version: "1.0.0",
      private: true,
      scripts: { postinstall: "node probe.cjs" },
    })
  );
  writeFileSync(
    path.join(install, "probe.cjs"),
    `
    const fs = require('node:fs');
    const path = require('node:path');
    const canary = ${JSON.stringify(canary)};
    let read = false, write = false;
    try { fs.readFileSync(canary); read = true; } catch {}
    try { fs.writeFileSync(canary, 'host-write', {flag:'r+'}); write = true; } catch {}
    fs.writeFileSync(path.join(process.env.HOME, 'lifecycle-home'), 'private');
    fs.writeFileSync('result.json', JSON.stringify({read, write,
      secret: process.env.VIBESTUDIO_NPM_HOST_SECRET ?? null,
      npmToken: process.env.NPM_TOKEN ?? null,
      userConfig: process.env.npm_config_userconfig ?? null,
      home: process.env.HOME, cache: process.env.npm_config_cache }));
  `
  );
  vi.stubEnv("VIBESTUDIO_NPM_HOST_SECRET", "host-only-canary");
  vi.stubEnv("NPM_TOKEN", "synthetic-host-token");
  vi.stubEnv("npm_config_userconfig", canary);
  try {
    await runNpmInstall(install, { appRoot, ignoreScripts: false, timeout: 30_000 });
    const result = JSON.parse(readFileSync(path.join(install, "result.json"), "utf8"));
    expect(result).toMatchObject({
      read: process.platform === "win32",
      write: process.platform === "win32",
      secret: null,
      npmToken: null,
    });
    expect(result.home).not.toBe(os.homedir());
    expect(result.userConfig).not.toBe(canary);
    expect(result.cache).toContain(path.dirname(result.home));
    // Linux may create an unrelated private file at a hidden host pathname;
    // opening the existing canary and checking host bytes tests real authority.
    expect(readFileSync(canary, "utf8")).toBe(
      process.platform === "win32" ? "host-write" : "unchanged"
    );
    expect(() => readFileSync(path.join(result.home, "lifecycle-home"))).toThrow();
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);
