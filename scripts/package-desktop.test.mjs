import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  appOutDirectoryName,
  excludedNativePackages,
  linuxAppDirectoryName,
  packageDesktop,
} from "./package-desktop.mjs";
import { writeAfterPackCompletion } from "./lib/after-pack-completion.mjs";
import { Platform } from "electron-builder";
import { parse } from "yaml";
import { getMainFileMatchers, getNodeModuleFileMatcher } from "app-builder-lib/out/fileMatcher.js";
import { AppFileWalker } from "app-builder-lib/out/util/AppFileWalker.js";
import { NodeModuleCopyHelper } from "app-builder-lib/out/util/NodeModuleCopyHelper.js";
import { PnpmNodeModulesCollector } from "app-builder-lib/out/node-module-collector/pnpmNodeModulesCollector.js";
import { includeDesktopRuntimeScriptClosure } from "./lib/npm-runtime-script-closure.mjs";
import includeRuntimeModuleFile from "./electron-runtime-module-files.mjs";

const roots = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-package-test-"));
  roots.push(root);
  for (const [name, cpu] of [
    ["workerd-linux-64", "x64"],
    ["workerd-linux-arm64", "arm64"],
  ]) {
    const dir = path.join(root, "node_modules/@cloudflare", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: `@cloudflare/${name}`, os: ["linux"], cpu: [cpu] })
    );
  }
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: {} }));
  fs.mkdirSync(path.join(root, "scripts/cli"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts/lib"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "scripts/cli/entry.mjs"),
    `import "../lib/runtime-helper.mjs";\n`
  );
  fs.writeFileSync(
    path.join(root, "scripts/lib/runtime-helper.mjs"),
    `export const ready = true;\n`
  );
  fs.writeFileSync(
    path.join(root, "electron-builder.yml"),
    `directories:\n  output: release\nfiles: ["dist/**/*", "scripts/cli/**/*", "node_modules/**/*"]\nasarUnpack: ["scripts/cli/**/*"]\nafterPack: ./scripts/electron-after-pack.mjs\nlinux:\n  target:\n    - target: deb\n      arch: [x64, arm64]\n`
  );
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("preserves the canonical ordered package boundary across both closure passes", async () => {
  const root = fixture();
  const config = parse(
    fs.readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8")
  );
  const payloads = [
    "dist/main.cjs",
    "dist/host-generations/desktop-old/node_modules/electron/dist/electron",
    "dist/node/releases/linux-x64/bin/node",
    "dist/node-payload/releases/linux-x64/bin/node",
    "dist/native-process-observer/linux-x64/observer",
    "dist/source-server-prerequisites.lock",
    "dist/host-build.lock",
    "packages/env-paths/src/index.ts",
    "packages/env-paths/dist/index.d.ts",
    "packages/env-paths/node_modules/electron/dist/electron",
    "node_modules/.pnpm/development-package/index.js",
    "node_modules/entities/index.js",
    "node_modules/htmlparser2/node_modules/entities/index.js",
    "unrelated-private-source.txt",
  ];
  for (const relative of payloads) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, "fixture");
  }
  // package-desktop adds the target exclusions between its closure pass and
  // beforePack's second pass. Neither pass may turn a negative rule into an
  // independent copy root, or route dependencies around their collector.
  includeDesktopRuntimeScriptClosure(root, config);
  config.files.push(
    ...excludedNativePackages(root, "linux", "x64").map((name) => `!node_modules/${name}{,/**/*}`)
  );
  const filesBeforeSecondPass = structuredClone(config.files);
  includeDesktopRuntimeScriptClosure(root, config);
  assert.deepEqual(config.files, filesBeforeSecondPass);

  const out = path.join(root, "release");
  const destination = path.join(out, "app");
  const packager = {
    config: { ...config, onNodeModuleFile: includeRuntimeModuleFile },
    projectDir: root,
    buildResourcesDir: "build-resources",
    debugLogger: { isEnabled: false },
    appInfo: { type: "module" },
    getWorkspaceRoot: async () => root,
  };
  const matchers = getMainFileMatchers(
    root,
    destination,
    (value) => value,
    {},
    { info: packager },
    out,
    false
  );
  const walkers = matchers.map((matcher) => new AppFileWalker(matcher, packager));
  const admitted = (relative) => {
    const absolute = path.join(root, relative);
    return walkers.some(({ matcher, filter }) => {
      const within = path.relative(matcher.from, absolute);
      return (
        !within.startsWith("..") &&
        !path.isAbsolute(within) &&
        filter(absolute, fs.statSync(absolute))
      );
    });
  };
  for (const relative of [
    "dist/main.cjs",
    "scripts/cli/entry.mjs",
    "scripts/lib/runtime-helper.mjs",
    "packages/env-paths/src/index.ts",
    "packages/env-paths/dist/index.d.ts",
  ])
    assert.equal(admitted(relative), true, relative);
  for (const relative of payloads.filter(
    (file) =>
      ![
        "dist/main.cjs",
        "packages/env-paths/src/index.ts",
        "packages/env-paths/dist/index.d.ts",
      ].includes(file)
  ))
    assert.equal(admitted(relative), false, relative);

  const moduleMatcher = getNodeModuleFileMatcher(root, destination, (value) => value, {}, packager);
  const moduleFilter = moduleMatcher.createFilter();
  for (const [name, kept] of [
    ["workerd-linux-64", true],
    ["workerd-linux-arm64", false],
  ]) {
    const file = path.join(root, "node_modules/@cloudflare", name, "package.json");
    assert.equal(moduleFilter(file, fs.statSync(file)), kept, name);
  }
  // Real linked SDK packages keep source/type exports, but their development
  // installs are not traversed. Required nested modules are copied separately
  // at their collector-selected version and destination.
  const copier = new NodeModuleCopyHelper(moduleMatcher, packager);
  const sdkRoot = path.join(root, "packages/env-paths");
  const sdkFiles = await copier.collectNodeModules(
    { name: "@vibestudio/env-paths", dir: sdkRoot },
    [".d.ts"],
    "node_modules/@vibestudio/env-paths"
  );
  assert.deepEqual(sdkFiles.map((file) => path.relative(sdkRoot, file)).sort(), [
    "dist/index.d.ts",
    "src/index.ts",
  ]);
  const nestedRoot = path.join(root, "node_modules/htmlparser2/node_modules/entities");
  assert.deepEqual(
    await copier.collectNodeModules(
      { name: "entities", dir: nestedRoot },
      [],
      "node_modules/htmlparser2/node_modules/entities"
    ),
    [path.join(nestedRoot, "index.js")]
  );
});

test("selects one native architecture using the packager's real file matcher", () => {
  const root = fixture();
  const names = excludedNativePackages(root, "linux", "x64");
  assert.deepEqual(names, ["@cloudflare/workerd-linux-arm64"]);
  const files = names.map((name) => `!node_modules/${name}{,/**/*}`);
  const matcher = getNodeModuleFileMatcher(
    root,
    "/out",
    (value) => value,
    {},
    { config: { files }, debugLogger: { isEnabled: false } }
  );
  const filter = matcher.createFilter();
  for (const [name, kept] of [
    ["workerd-linux-64", true],
    ["workerd-linux-arm64", false],
  ]) {
    const file = path.join(root, "node_modules/@cloudflare", name, "package.json");
    assert.equal(filter(file, fs.statSync(file)), kept);
  }
});

test("selects the glibc runtime required by desktop Linux", () => {
  const root = fixture();
  for (const libc of ["glibc", "musl"]) {
    const name = `@native/runtime-${libc}`;
    const directory = path.join(root, "node_modules", name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ name, os: ["linux"], cpu: ["x64"], libc: [libc] })
    );
  }
  const excluded = excludedNativePackages(root, "linux", "x64");
  assert.ok(excluded.includes("@native/runtime-musl"));
  assert.ok(!excluded.includes("@native/runtime-glibc"));
});

test("derives the exact app output identity for Mac and Windows targets", () => {
  assert.equal(appOutDirectoryName(Platform.MAC, "arm64", { mac: {} }), "mac-arm64");
  assert.equal(appOutDirectoryName(Platform.WINDOWS, "x64", { win: {} }), "win-unpacked");
});

test("collects exact nested versions from a hoisted pnpm installation", async () => {
  const root = fixture();
  for (const [relative, version] of [
    ["entities", "8.1.0"],
    ["htmlparser2/node_modules/entities", "7.0.1"],
  ]) {
    const directory = path.join(root, "node_modules", relative);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ name: "entities", version })
    );
  }
  const collector = new PnpmNodeModulesCollector(root, null);
  collector.isHoisted = { value: Promise.resolve(true) };
  // pnpm reports a virtual-store coordinate even though nodeLinker is hoisted.
  const reported = path.join(root, "node_modules/.pnpm/entities@7.0.1/node_modules/entities");
  const selected = await collector.locateFromDepOrRoot("entities", reported, "7.0.1");
  assert.equal(
    selected.packageDir,
    path.join(root, "node_modules/htmlparser2/node_modules/entities")
  );
  assert.equal(selected.packageJson.version, "7.0.1");
  assert.equal(await collector.locateFromDepOrRoot("entities", reported, "6.0.0"), null);
});

test("promotes final installers and retires each joined staging tree", async () => {
  const root = fixture();
  const seen = [];
  const outputs = await packageDesktop("linux", {
    appRoot: root,
    arch: "x64",
    runBuild: async ({ config: configPath, targets }) => {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const arch = [...targets.values()][0].keys().next().value;
      seen.push(config);
      writeAfterPackCompletion({
        outDir: config.directories.output,
        appOutDir: path.join(config.directories.output, "linux-unpacked"),
        electronPlatformName: "linux",
        arch,
      });
      fs.mkdirSync(path.join(config.directories.output, "linux-unpacked"));
      const installer = path.join(config.directories.output, `installer-${arch}.deb`);
      fs.writeFileSync(installer, "verified final artifact");
      return [installer];
    },
  });
  assert.equal(outputs.length, 1);
  assert.ok(
    seen[0].files.some(
      (file) =>
        typeof file === "string" && file.startsWith("!node_modules/@cloudflare/workerd-linux-arm64")
    )
  );
  assert.ok(seen[0].files.includes("scripts/lib/runtime-helper.mjs"));
  assert.ok(seen[0].asarUnpack.includes("scripts/lib/runtime-helper.mjs"));
  assert.deepEqual(fs.readdirSync(path.join(root, "release")).sort(), ["installer-1.deb"]);
});

test("produces one Linux application through the canonical configured packager", async () => {
  const root = fixture();
  let buildOptions;
  const published = await packageDesktop("linux", {
    appRoot: root,
    arch: "arm64",
    linuxMode: "app",
    runBuild: async (options) => {
      buildOptions = options;
      const config = JSON.parse(fs.readFileSync(options.config, "utf8"));
      assert.equal(config.afterPack, "./scripts/electron-after-pack.mjs");
      assert.equal(options.prepackaged, undefined);
      assert.equal(linuxAppDirectoryName("arm64", config.linux), "linux-arm64-unpacked");
      assert.deepEqual([...options.targets.values()][0].keys().next().value, 3);
      const appOutput = path.join(
        config.directories.output,
        linuxAppDirectoryName("arm64", config.linux)
      );
      writeAfterPackCompletion({
        outDir: config.directories.output,
        appOutDir: appOutput,
        electronPlatformName: "linux",
        arch: 3,
      });
      const resources = path.join(appOutput, "resources");
      fs.mkdirSync(path.join(resources, "userland-builds"), { recursive: true });
      fs.writeFileSync(
        path.join(resources, "userland-builds/release.json"),
        JSON.stringify(validPreparedWorkspaceRelease("arm64"))
      );
      fs.writeFileSync(path.join(appOutput, "vibestudio"), "app");
      return [];
    },
  });

  assert.ok(buildOptions);
  assert.deepEqual(published, [path.join(root, "release/linux-unpacked")]);
  assert.equal(
    fs.readFileSync(path.join(root, "release/linux-unpacked/vibestudio"), "utf8"),
    "app"
  );
  assert.deepEqual(fs.readdirSync(path.join(root, "release")), ["linux-unpacked"]);
});

test("does not promote a Linux application without the canonical completed release seal", async () => {
  const root = fixture();
  await assert.rejects(
    packageDesktop("linux", {
      appRoot: root,
      arch: "x64",
      linuxMode: "app",
      runBuild: async ({ config: configPath }) => {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        const appOutput = path.join(
          config.directories.output,
          linuxAppDirectoryName("x64", config.linux)
        );
        writeAfterPackCompletion({
          outDir: config.directories.output,
          appOutDir: appOutput,
          electronPlatformName: "linux",
          arch: 1,
        });
        fs.mkdirSync(path.join(appOutput, "resources"), { recursive: true });
        fs.writeFileSync(path.join(appOutput, "vibestudio"), "incomplete");
        return [];
      },
    }),
    /complete prepared workspace release/u
  );
  assert.deepEqual(fs.readdirSync(path.join(root, "release")), []);
});

test("does not promote an app when the packager returns without an afterPack receipt", async () => {
  const root = fixture();
  await assert.rejects(
    packageDesktop("linux", {
      appRoot: root,
      arch: "x64",
      linuxMode: "app",
      runBuild: async () => [],
    }),
    /without completing its afterPack hook/u
  );
  assert.deepEqual(fs.readdirSync(path.join(root, "release")), []);
});

test("preserves the original Linux app hook failure and does not promote its output", async () => {
  const root = fixture();
  const failure = new Error("afterPack workspace preparation failed");
  await assert.rejects(
    packageDesktop("linux", {
      appRoot: root,
      arch: "arm64",
      linuxMode: "app",
      runBuild: async () => {
        throw failure;
      },
    }),
    (error) => error === failure
  );
  assert.deepEqual(fs.readdirSync(path.join(root, "release")), []);
});

test("fails and retires owned staging if the builder promise outlives all event-loop work", () => {
  const root = fixture();
  const moduleUrl = new URL("./package-desktop.mjs", import.meta.url).href;
  const source =
    `import { packageDesktop } from ${JSON.stringify(moduleUrl)};\n` +
    `void packageDesktop("linux", { appRoot: ${JSON.stringify(root)}, arch: "x64", linuxMode: "app", runBuild: () => new Promise(() => {}) });\n`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(child.error, undefined);
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /remained pending after Node had no active work/u);
  assert.deepEqual(fs.readdirSync(path.join(root, "release")), []);
});

test("packages one declared Linux format from an isolated prepackaged app copy", async () => {
  const root = fixture();
  const prepackaged = path.join(root, "release/linux-unpacked");
  fs.mkdirSync(prepackaged, { recursive: true });
  let buildOptions;
  const published = await packageDesktop("linux", {
    appRoot: root,
    arch: "x64",
    linuxMode: "format",
    linuxFormat: "deb",
    prepackaged: "release/linux-unpacked",
    runBuild: async (options) => {
      buildOptions = options;
      assert.equal(options.prepackaged, prepackaged);
      assert.deepEqual([...options.targets.values()][0].keys().next().value, 1);
      const artifact = path.join(
        JSON.parse(fs.readFileSync(options.config, "utf8")).directories.output,
        "vibestudio.deb"
      );
      fs.writeFileSync(artifact, "deb");
      return [artifact];
    },
  });

  assert.ok(buildOptions);
  assert.deepEqual(published, [path.join(root, "release/vibestudio.deb")]);
  assert.equal(fs.readFileSync(published[0], "utf8"), "deb");
  assert.ok(fs.existsSync(prepackaged));
  assert.deepEqual(fs.readdirSync(path.join(root, "release")).sort(), [
    "linux-unpacked",
    "vibestudio.deb",
  ]);
});

test("retires failed packaging scratch while preserving inherited release products", async () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, "release"));
  fs.writeFileSync(path.join(root, "release", "previous.deb"), "previous release");
  const failure = new Error("native packaging failed");
  await assert.rejects(
    packageDesktop("linux", {
      appRoot: root,
      runBuild: async () => {
        throw failure;
      },
    }),
    (error) => error === failure
  );
  assert.deepEqual(fs.readdirSync(path.join(root, "release")), ["previous.deb"]);
});

function validPreparedWorkspaceRelease(arch) {
  const pin = (commit) => ({
    url: "git+https://example.test/vibestudio.git",
    ref: "refs/tags/v1",
    commit,
  });
  return {
    format: "vibestudio-workspace-runtime-release/4",
    version: 4,
    producedOn: { platform: "linux", arch },
    appDependencyFingerprint: "a".repeat(64),
    hostBuild: {
      version: 1,
      mode: "production",
      fingerprint: "b".repeat(64),
      inputCount: 1,
    },
    compilerProtocol: {
      cacheVersion: "test-cache",
      panelEntryProtocolFingerprint: "c".repeat(64),
    },
    templates: {
      base: pin("1".repeat(40)),
      personal: pin("2".repeat(40)),
      system: pin("3".repeat(40)),
    },
    layers: {
      base: [pin("1".repeat(40))],
      personal: [pin("2".repeat(40))],
      system: [pin("3".repeat(40))],
    },
    preparedTemplates: ["base", "personal", "system"].map((workspace, index) => ({
      workspace,
      recordDigest: String(index + 4).repeat(64),
    })),
    builds: ["base", "personal", "system"].map((workspace, index) => ({
      workspace,
      source: "panels/chat",
      buildKey: String(index + 7).repeat(64),
      builtAt: "2026-10-12T00:00:00.000Z",
    })),
  };
}
