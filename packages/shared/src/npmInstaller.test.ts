import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const getCentralDataPath = vi.hoisted(() => vi.fn<() => string>());
vi.mock("@vibestudio/env-paths", () => ({ getCentralDataPath }));

import { runNpmInstall } from "./npmInstaller.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runNpmInstall", () => {
  it("uses a Vibestudio-owned cache instead of the user's npm cache", async () => {
    const fixture = createFakeNpmFixture();
    const centralDataPath = path.join(fixture.root, "vibestudio-data");
    getCentralDataPath.mockReturnValue(centralDataPath);
    const restoreEnv = replaceEnv({
      VIBESTUDIO_APP_ROOT: fixture.appRoot,
      npm_config_cache: path.join(fixture.root, "poisoned-user-cache"),
    });

    try {
      // Keep the legacy numeric options form covered for existing callers.
      await runNpmInstall(fixture.installDir, 5_000);
    } finally {
      restoreEnv();
    }

    const [args] = readAttempts(fixture.installDir);
    expect(cacheArg(args!)).toBe(path.join(centralDataPath, "npm-cache"));
    expect(args).toContain("--ignore-scripts");
  });

  it("retries a corrupt cacache read once with a clean temporary cache", async () => {
    const fixture = createFakeNpmFixture();
    const primaryCache = path.join(fixture.root, "primary-cache");
    const restoreEnv = replaceEnv({
      VIBESTUDIO_APP_ROOT: fixture.appRoot,
      VIBESTUDIO_NPM_INSTALLER_TEST_FAIL_CACHE: primaryCache,
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await runNpmInstall(fixture.installDir, {
        timeout: 5_000,
        ignoreScripts: false,
        cacheDir: primaryCache,
      });
    } finally {
      restoreEnv();
    }

    const attempts = readAttempts(fixture.installDir);
    expect(attempts).toHaveLength(2);
    expect(cacheArg(attempts[0]!)).toBe(primaryCache);
    const recoveryCache = cacheArg(attempts[1]!);
    expect(recoveryCache).toMatch(/vibestudio-npm-cache-recovery-/);
    expect(fs.existsSync(recoveryCache)).toBe(false);
    expect(attempts.every((args) => !args.includes("--ignore-scripts"))).toBe(true);
  });

  it("does not retry ordinary npm failures", async () => {
    const fixture = createFakeNpmFixture();
    const restoreEnv = replaceEnv({
      VIBESTUDIO_APP_ROOT: fixture.appRoot,
      VIBESTUDIO_NPM_INSTALLER_TEST_ERROR: "npm error code E401: authentication required",
    });

    try {
      await expect(
        runNpmInstall(fixture.installDir, {
          timeout: 5_000,
          cacheDir: path.join(fixture.root, "primary-cache"),
        })
      ).rejects.toThrow("Command failed");
    } finally {
      restoreEnv();
    }

    expect(readAttempts(fixture.installDir)).toHaveLength(1);
  });

  it("retries transient network failures", async () => {
    const fixture = createFakeNpmFixture();
    getCentralDataPath.mockReturnValue(path.join(fixture.root, "vibestudio-data"));
    const restoreEnv = replaceEnv({
      VIBESTUDIO_APP_ROOT: fixture.appRoot,
      VIBESTUDIO_NPM_INSTALLER_TEST_FAIL_ONCE: "1",
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await runNpmInstall(fixture.installDir, { timeout: 5_000 });
    } finally {
      restoreEnv();
    }

    expect(readAttempts(fixture.installDir)).toHaveLength(2);
  });

  it("hard-stops and retries an npm process that ignores SIGTERM", async () => {
    const fixture = createFakeNpmFixture();
    getCentralDataPath.mockReturnValue(path.join(fixture.root, "vibestudio-data"));
    const restoreEnv = replaceEnv({
      VIBESTUDIO_APP_ROOT: fixture.appRoot,
      VIBESTUDIO_NPM_INSTALLER_TEST_HANG_ONCE: "1",
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      // Leave enough time for a cold Node process to start and persist its
      // first-attempt marker before exercising the install deadline.
      await runNpmInstall(fixture.installDir, { timeout: 500 });
    } finally {
      restoreEnv();
    }

    expect(readAttempts(fixture.installDir)).toHaveLength(2);
  });
});

function createFakeNpmFixture(): { root: string; appRoot: string; installDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-npm-installer-test-"));
  tempDirs.push(root);
  const appRoot = path.join(root, "app");
  const npmRoot = path.join(appRoot, "node_modules", "npm");
  const installDir = path.join(root, "install");
  fs.mkdirSync(path.join(npmRoot, "bin"), { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(appRoot, "package.json"), JSON.stringify({ private: true }));
  fs.writeFileSync(
    path.join(npmRoot, "package.json"),
    JSON.stringify({ name: "npm", version: "0.0.0" })
  );
  fs.writeFileSync(
    path.join(npmRoot, "bin", "npm-cli.js"),
    `
const fs = require("node:fs");
const path = require("node:path");
const attemptsPath = path.join(process.cwd(), "attempts.json");
const attempts = fs.existsSync(attemptsPath)
  ? JSON.parse(fs.readFileSync(attemptsPath, "utf8"))
  : [];
const args = process.argv.slice(2);
attempts.push(args);
fs.writeFileSync(attemptsPath, JSON.stringify(attempts));
if (process.env.VIBESTUDIO_NPM_INSTALLER_TEST_HANG_ONCE && attempts.length === 1) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
  return;
}
if (process.env.VIBESTUDIO_NPM_INSTALLER_TEST_FAIL_ONCE && attempts.length === 1) {
  process.stderr.write("npm error network ETIMEDOUT while fetching package\\n");
  process.exit(1);
}
const cacheIndex = args.indexOf("--cache");
const cacheDir = cacheIndex >= 0 ? args[cacheIndex + 1] : "";
if (process.env.VIBESTUDIO_NPM_INSTALLER_TEST_FAIL_CACHE === cacheDir) {
  process.stderr.write(
    "npm error ENOENT: Invalid response body, stat '" +
      path.join(cacheDir, "_cacache", "content-v2", "sha512", "missing") +
      "'\\n"
  );
  process.exit(1);
}
if (process.env.VIBESTUDIO_NPM_INSTALLER_TEST_ERROR) {
  process.stderr.write(process.env.VIBESTUDIO_NPM_INSTALLER_TEST_ERROR + "\\n");
  process.exit(1);
}
`
  );
  return { root, appRoot, installDir };
}

function readAttempts(installDir: string): string[][] {
  return JSON.parse(fs.readFileSync(path.join(installDir, "attempts.json"), "utf8")) as string[][];
}

function cacheArg(args: string[]): string {
  const index = args.indexOf("--cache");
  expect(index).toBeGreaterThanOrEqual(0);
  return args[index + 1]!;
}

function replaceEnv(values: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
