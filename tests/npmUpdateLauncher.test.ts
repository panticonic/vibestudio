import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkForActiveUpdateLock,
  createUpdateLaunch,
  handleElectronUpdateExit,
  resolveNpmGlobalInstall,
} from "../scripts/npm-update-launcher.mjs";
import {
  NPM_DESKTOP_PACKAGE_NAME,
  NPM_UPDATE_CONTRACT_VERSION,
  NPM_UPDATE_FILES,
  NPM_UPDATE_REQUESTED_EXIT_CODE,
  readPrivateJson,
  validateUpdateResult,
  writePrivateJsonAtomic,
} from "../scripts/npm-update-contract.mjs";

describe.skipIf(process.platform === "win32")("npm update launcher provenance", () => {
  it("proves only the exact global desktop package root", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-provenance-"));
    const prefix = path.join(fixture, "prefix");
    const globalRoot = path.join(prefix, "lib", "node_modules");
    const packageRoot = path.join(globalRoot, "@panticonic", "vibestudio");
    const bin = path.join(fixture, "bin");
    const central = path.join(fixture, "central");
    fs.mkdirSync(path.join(packageRoot, "node_modules", "electron"), { recursive: true });
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@panticonic/vibestudio", version: "1.2.3" })
    );
    const npm = path.join(bin, "npm");
    fs.writeFileSync(
      npm,
      `#!/usr/bin/env node\nconsole.log(process.argv.includes("root") ? process.env.TEST_GLOBAL_ROOT : process.env.TEST_GLOBAL_PREFIX)\n`
    );
    fs.chmodSync(npm, 0o755);
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      TEST_GLOBAL_ROOT: globalRoot,
      TEST_GLOBAL_PREFIX: prefix,
    };

    await expect(
      resolveNpmGlobalInstall(packageRoot, { env, centralDataPath: central })
    ).resolves.toMatchObject({
      packageName: "@panticonic/vibestudio",
      packageRoot: fs.realpathSync(packageRoot),
      globalRoot: fs.realpathSync(globalRoot),
      globalPrefix: fs.realpathSync(prefix),
      currentVersion: "1.2.3",
      canInstall: true,
    });

    const localRoot = path.join(fixture, "project", "node_modules", "@panticonic", "vibestudio");
    fs.mkdirSync(path.join(localRoot, "node_modules", "electron"), { recursive: true });
    fs.writeFileSync(
      path.join(localRoot, "package.json"),
      JSON.stringify({ name: "@panticonic/vibestudio", version: "1.2.3" })
    );
    await expect(
      resolveNpmGlobalInstall(localRoot, { env, centralDataPath: central })
    ).resolves.toBeNull();
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  it("refuses a live update lock and prunes a dead owner's lock", async () => {
    const central = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-lock-"));
    const lockPath = path.join(central, NPM_UPDATE_FILES.lock);
    const live = {
      contractVersion: NPM_UPDATE_CONTRACT_VERSION,
      pid: process.pid,
      targetVersion: "2.0.0",
      startedAt: new Date().toISOString(),
      token: "live",
      resultPath: "/private/result.json",
    };
    fs.writeFileSync(lockPath, JSON.stringify(live), { mode: 0o600 });
    await expect(checkForActiveUpdateLock(central)).resolves.toMatchObject({ active: true });

    fs.writeFileSync(lockPath, JSON.stringify({ ...live, pid: 2_147_483_647, token: "dead" }), {
      mode: 0o600,
    });
    await expect(checkForActiveUpdateLock(central)).resolves.toMatchObject({ active: false });
    expect(fs.existsSync(lockPath)).toBe(false);
    fs.rmSync(central, { recursive: true, force: true });
  });
});

describe
  .skipIf(process.platform === "win32")
  .sequential("npm update launcher orchestration", () => {
    it("installs and verifies the selected exact version without a shell", async () => {
      const fixture = createInstallerFixture();
      try {
        const result = await runFixtureUpdate(fixture, false);
        expect(result.outcome).toBe("succeeded");
        expect(readManifestVersion(fixture.packageRoot)).toBe("2.0.0");
        const invocations = fs
          .readFileSync(fixture.invocationsPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(invocations).toContainEqual([
          "install",
          "--global",
          "--prefix",
          fs.realpathSync(fixture.prefix),
          `${NPM_DESKTOP_PACKAGE_NAME}@2.0.0`,
        ]);
        expect(fs.existsSync(path.join(fixture.central, NPM_UPDATE_FILES.lock))).toBe(false);
        expect(
          JSON.parse(
            fs.readFileSync(
              path.join(fixture.central, "host-versions", "1", "workspace-host.json"),
              "utf8"
            )
          )
        ).toMatchObject({ systemEpoch: 1, appVersion: "1.0.0" });
      } finally {
        fixture.cleanup();
      }
    });

    it("restores the previous exact version after target postinstall failure", async () => {
      const fixture = createInstallerFixture();
      try {
        const result = await runFixtureUpdate(fixture, true);
        expect(result.outcome).toBe("restored");
        expect(readManifestVersion(fixture.packageRoot)).toBe("1.0.0");
        const invocations = fs.readFileSync(fixture.invocationsPath, "utf8");
        expect(invocations).toContain(`${NPM_DESKTOP_PACKAGE_NAME}@2.0.0`);
        expect(invocations).toContain(`${NPM_DESKTOP_PACKAGE_NAME}@1.0.0`);
      } finally {
        fixture.cleanup();
      }
    });

    it("rejects an otherwise-valid request with the wrong invocation nonce", async () => {
      const fixture = createInstallerFixture();
      try {
        const result = await runFixtureUpdate(fixture, false, "b".repeat(64));
        expect(result.outcome).toBe("failed");
        expect(result.summary).toMatch(/authority did not validate/);
        expect(readManifestVersion(fixture.packageRoot)).toBe("1.0.0");
        expect(fs.existsSync(fixture.invocationsPath)).toBe(false);
      } finally {
        fixture.cleanup();
      }
    });
  });

function createInstallerFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-installer-"));
  const prefix = path.join(root, "prefix");
  const globalRoot = path.join(prefix, "lib", "node_modules");
  const packageRoot = path.join(globalRoot, "@panticonic", "vibestudio");
  const bin = path.join(root, "bin");
  const central = path.join(root, "central");
  const invocationsPath = path.join(root, "npm-invocations.jsonl");
  fs.mkdirSync(path.join(packageRoot, "node_modules", "electron"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
  fs.mkdirSync(bin);
  writeManifest(packageRoot, "1.0.0");
  fs.writeFileSync(path.join(packageRoot, "dist", "server.mjs"), "export {};\n");
  fs.writeFileSync(path.join(packageRoot, "scripts", "vibestudio-launcher.mjs"), "");
  const electronRoot = path.join(packageRoot, "node_modules", "electron");
  const electronRelative = path.join("Electron.app", "Contents", "MacOS", "Electron");
  const electronExecutable = path.join(electronRoot, "dist", electronRelative);
  fs.mkdirSync(path.dirname(electronExecutable), { recursive: true });
  fs.writeFileSync(
    electronExecutable,
    "#!/usr/bin/env node\nprocess.stdout.write(process.version);\n"
  );
  fs.chmodSync(electronExecutable, 0o755);
  fs.writeFileSync(path.join(electronRoot, "path.txt"), electronRelative);
  const npm = path.join(bin, "npm");
  fs.writeFileSync(
    npm,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "root") console.log(process.env.TEST_GLOBAL_ROOT);
else if (args[0] === "prefix") console.log(process.env.TEST_GLOBAL_PREFIX);
else {
  fs.appendFileSync(process.env.TEST_INVOCATIONS, JSON.stringify(args) + "\\n");
  const version = args.at(-1).split("@").at(-1);
  fs.writeFileSync(path.join(process.env.TEST_PACKAGE_ROOT, "package.json"), JSON.stringify({
    name: "@panticonic/vibestudio",
    version,
  }));
  if (version === "2.0.0" && process.env.TEST_FAIL_TARGET === "1") process.exit(42);
}
`
  );
  fs.chmodSync(npm, 0o755);
  return {
    root,
    prefix,
    globalRoot,
    packageRoot,
    bin,
    central,
    invocationsPath,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function runFixtureUpdate(
  fixture: ReturnType<typeof createInstallerFixture>,
  failTarget: boolean,
  requestNonce?: string
) {
  const previous = {
    PATH: process.env.PATH,
    TEST_GLOBAL_ROOT: process.env["TEST_GLOBAL_ROOT"],
    TEST_GLOBAL_PREFIX: process.env["TEST_GLOBAL_PREFIX"],
    TEST_PACKAGE_ROOT: process.env["TEST_PACKAGE_ROOT"],
    TEST_INVOCATIONS: process.env["TEST_INVOCATIONS"],
    TEST_FAIL_TARGET: process.env["TEST_FAIL_TARGET"],
  };
  process.env.PATH = `${fixture.bin}${path.delimiter}${previous.PATH ?? ""}`;
  process.env["TEST_GLOBAL_ROOT"] = fixture.globalRoot;
  process.env["TEST_GLOBAL_PREFIX"] = fixture.prefix;
  process.env["TEST_PACKAGE_ROOT"] = fixture.packageRoot;
  process.env["TEST_INVOCATIONS"] = fixture.invocationsPath;
  process.env["TEST_FAIL_TARGET"] = failTarget ? "1" : "0";
  try {
    const provenance = await resolveNpmGlobalInstall(fixture.packageRoot, {
      centralDataPath: fixture.central,
    });
    expect(provenance).not.toBeNull();
    const launch = createUpdateLaunch(provenance!);
    const requestPath = path.join(launch.requestDirectory, NPM_UPDATE_FILES.request);
    writePrivateJsonAtomic(requestPath, {
      contractVersion: NPM_UPDATE_CONTRACT_VERSION,
      action: "install-update",
      packageName: NPM_DESKTOP_PACKAGE_NAME,
      nonce: requestNonce ?? launch.nonce,
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      requestedAt: new Date().toISOString(),
    });
    const handled = await handleElectronUpdateExit({
      code: NPM_UPDATE_REQUESTED_EXIT_CODE,
      signal: null,
      launch,
      centralDataPath: fixture.central,
    });
    expect(handled).toMatchObject({ handled: true, relaunched: true });
    const result = readPrivateJson(handled.resultPath, validateUpdateResult);
    expect(result).not.toBeNull();
    return result!;
  } finally {
    restoreEnvironment(previous);
  }
}

function writeManifest(packageRoot: string, version: string) {
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: NPM_DESKTOP_PACKAGE_NAME, version })
  );
}

function readManifestVersion(packageRoot: string): string {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
}

function restoreEnvironment(previous: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
}
