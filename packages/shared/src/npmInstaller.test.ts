import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Unit tests exercise real npm-shaped processes; native enforcement has its
// own integration fixture using the installed executor.
vi.mock("@vibestudio/process-adapter/native-launch", () => ({
  assertNativePrerequisites: vi.fn(),
  compileNativeLaunch: vi.fn((input) => ({
    command: input.argv[0],
    args: input.argv.slice(1),
    cwd: input.cwd,
    environment: input.guestEnvironment,
  })),
}));
vi.mock("./nativeRuntimeResources.js", () => ({
  prepareNativeRuntime: ({ appRoot }: { appRoot: string }) => ({
    npmCli: path.join(appRoot, "node_modules", "npm", "bin", "npm-cli.js"),
    executable: process.execPath,
    readPaths: [path.dirname(process.execPath)],
    environment: process.platform === "win32" ? { SystemRoot: process.env["SystemRoot"]! } : {},
  }),
}));
vi.mock("./nativeWorkspaceCleanup.js", () => ({
  nativeWorkspaceCleanup: () => (root: string) => fs.rmSync(root, { recursive: true, force: true }),
}));

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
    const sharedDerivedDataPath = path.join(fixture.root, "shared-derived-data");

    const restoreEnv = replaceEnv({
      VIBESTUDIO_APP_ROOT: fixture.appRoot,
      npm_config_cache: path.join(fixture.root, "poisoned-user-cache"),
    });

    try {
      await runNpmInstall(fixture.installDir, { appRoot: fixture.appRoot });
    } finally {
      restoreEnv();
    }

    const [args] = readAttempts(fixture.installDir);
    expect(cacheArg(args!)).toMatch(/[\\/]workspace[\\/]cache$/);
    expect(cacheArg(args!)).not.toContain(sharedDerivedDataPath);
    expect(args).toContain("--ignore-scripts");
    expect(args).toContain("--legacy-peer-deps");
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
        appRoot: fixture.appRoot,
        timeout: 5_000,
        ignoreScripts: false,
      });
    } finally {
      restoreEnv();
    }

    const attempts = readAttempts(fixture.installDir);
    expect(attempts).toHaveLength(2);
    expect(cacheArg(attempts[0]!)).toMatch(/[\\/]workspace[\\/]cache$/);
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
          appRoot: fixture.appRoot,
          timeout: 5_000,
        })
      ).rejects.toThrow("Command failed");
    } finally {
      restoreEnv();
    }

    expect(readAttempts(fixture.installDir)).toHaveLength(1);
  });

  it("classifies registry package misses as dependency resolution failures", async () => {
    const fixture = createFakeNpmFixture();
    const restoreEnv = replaceEnv({
      VIBESTUDIO_APP_ROOT: fixture.appRoot,
      VIBESTUDIO_NPM_INSTALLER_TEST_ERROR:
        "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/missing\nnpm error 404 'missing@1.0.0' is not in this registry.",
    });

    try {
      await expect(
        runNpmInstall(fixture.installDir, {
          appRoot: fixture.appRoot,
          timeout: 5_000,
        })
      ).rejects.toMatchObject({
        name: "NpmResolutionError",
        reason: "package-not-found",
      });
    } finally {
      restoreEnv();
    }

    expect(readAttempts(fixture.installDir)).toHaveLength(1);
  });

  it("classifies missing versions separately from registry outages", async () => {
    const fixture = createFakeNpmFixture();
    const restoreEnv = replaceEnv({
      VIBESTUDIO_APP_ROOT: fixture.appRoot,
      VIBESTUDIO_NPM_INSTALLER_TEST_ERROR:
        "npm error code EETARGET\nnpm error notarget No matching version found for example@99.0.0.",
    });

    try {
      await expect(
        runNpmInstall(fixture.installDir, {
          appRoot: fixture.appRoot,
          timeout: 5_000,
        })
      ).rejects.toMatchObject({
        name: "NpmResolutionError",
        reason: "version-not-found",
      });
    } finally {
      restoreEnv();
    }

    expect(readAttempts(fixture.installDir)).toHaveLength(1);
  });

  it("retries transient network failures", async () => {
    const fixture = createFakeNpmFixture();

    const restoreEnv = replaceEnv({
      VIBESTUDIO_APP_ROOT: fixture.appRoot,
      VIBESTUDIO_NPM_INSTALLER_TEST_FAIL_ONCE: "1",
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await runNpmInstall(fixture.installDir, { appRoot: fixture.appRoot, timeout: 5_000 });
    } finally {
      restoreEnv();
    }

    expect(readAttempts(fixture.installDir)).toHaveLength(2);
  });

  it("bounds concurrent installs with independent private caches", async () => {
    const first = createFakeNpmFixture();
    const second = createFakeNpmFixture();
    const restoreEnv = replaceEnv({ VIBESTUDIO_NPM_INSTALLER_TEST_DELAY_MS: "200" });

    try {
      const firstInstall = runNpmInstall(first.installDir, { appRoot: first.appRoot });
      await vi.waitFor(() => expect(readAttempts(first.installDir)).toHaveLength(1));
      const secondInstall = runNpmInstall(second.installDir, { appRoot: second.appRoot });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fs.existsSync(path.join(second.installDir, "attempts.json"))).toBe(false);
      await Promise.all([firstInstall, secondInstall]);
    } finally {
      restoreEnv();
    }

    expect(readAttempts(second.installDir)).toHaveLength(1);
  });

  it("hard-stops and retries an npm process that ignores SIGTERM", async () => {
    const fixture = createFakeNpmFixture();

    const restoreEnv = replaceEnv({
      VIBESTUDIO_APP_ROOT: fixture.appRoot,
      VIBESTUDIO_NPM_INSTALLER_TEST_HANG_ONCE: "1",
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      // Leave enough time for a cold Node process to start and persist its
      // first-attempt marker before exercising the install deadline.
      await runNpmInstall(fixture.installDir, { appRoot: fixture.appRoot, timeout: 500 });
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
const control = JSON.parse(fs.readFileSync(path.join(process.cwd(), "control.json"), "utf8"));
const args = process.argv.slice(2);
attempts.push(args);
fs.writeFileSync(attemptsPath, JSON.stringify(attempts));
if (control.VIBESTUDIO_NPM_INSTALLER_TEST_HANG_ONCE && attempts.length === 1) {
  fs.mkdirSync(path.join(process.cwd(), "node_modules", "half-extracted"), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), "package-lock.json"), "partial lock");
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
  return;
}
if (
  control.VIBESTUDIO_NPM_INSTALLER_TEST_HANG_ONCE &&
  (fs.existsSync(path.join(process.cwd(), "node_modules")) ||
    fs.existsSync(path.join(process.cwd(), "package-lock.json")))
) {
  process.stderr.write("retry inherited a partial npm install\\n");
  process.exit(1);
}
if (control.VIBESTUDIO_NPM_INSTALLER_TEST_FAIL_ONCE && attempts.length === 1) {
  process.stderr.write("npm error network ETIMEDOUT while fetching package\\n");
  process.exit(1);
}
const cacheIndex = args.indexOf("--cache");
const cacheDir = cacheIndex >= 0 ? args[cacheIndex + 1] : "";
if (control.VIBESTUDIO_NPM_INSTALLER_TEST_FAIL_CACHE && attempts.length === 1) {
  process.stderr.write(
    "npm error ENOENT: Invalid response body, stat '" +
      path.join(cacheDir, "_cacache", "content-v2", "sha512", "missing") +
      "'\\n"
  );
  process.exit(1);
}
if (control.VIBESTUDIO_NPM_INSTALLER_TEST_ERROR) {
  process.stderr.write(control.VIBESTUDIO_NPM_INSTALLER_TEST_ERROR + "\\n");
  process.exit(1);
}
if (control.VIBESTUDIO_NPM_INSTALLER_TEST_DELAY_MS) {
  setTimeout(() => {}, Number(control.VIBESTUDIO_NPM_INSTALLER_TEST_DELAY_MS));
}
`
  );
  fs.writeFileSync(path.join(installDir, "control.json"), "{}");
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
  for (const root of tempDirs) {
    fs.writeFileSync(path.join(root, "install", "control.json"), JSON.stringify(values));
  }
  const prior = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  return () => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
